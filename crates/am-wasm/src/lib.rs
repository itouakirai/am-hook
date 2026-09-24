//! am-hook 浏览器端解密的 wasm 导出（C ABI），JS 调用方见 `src/ui/hook-worker.js`。
//!
//! 用法：`hook_alloc` 申请缓冲区 → 写入数据 → 调用处理函数（原地改写，长度不变）→ 读回 → `hook_free`。
//! 失败时返回值为 0 / null，错误信息通过 `hook_error_ptr` / `hook_error_len` 读取。

use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;

use am_mp4::{decrypt_fragment_in_place, fixed_template, patch_init_in_place, template_from_json, Template};

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

fn set_error(msg: String) {
    LAST_ERROR.with(|e| *e.borrow_mut() = msg);
}

#[no_mangle]
pub extern "C" fn hook_error_ptr() -> *const u8 {
    LAST_ERROR.with(|e| e.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn hook_error_len() -> usize {
    LAST_ERROR.with(|e| e.borrow().len())
}

#[no_mangle]
pub extern "C" fn hook_alloc(len: usize) -> *mut u8 {
    // SAFETY: 尺寸至少为 1，对齐为 1
    unsafe { alloc(Layout::from_size_align_unchecked(len.max(1), 1)) }
}

/// # Safety
/// `ptr` / `len` 必须来自同一次 `hook_alloc`。
#[no_mangle]
pub unsafe extern "C" fn hook_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), 1));
    }
}

/// 内嵌的固定 key 模板（每条轨道第一个 fragment 使用），无需释放。
#[no_mangle]
pub extern "C" fn hook_fixed_template() -> *const Template {
    fixed_template()
}

/// 解析 wrapper-lite `/key` 返回的 `data` JSON，返回模板句柄，需用 `hook_template_free` 释放。
///
/// # Safety
/// `ptr` 必须指向 `len` 字节的可读内存。
#[no_mangle]
pub unsafe extern "C" fn hook_template_load(ptr: *const u8, len: usize) -> *mut Template {
    let bytes = std::slice::from_raw_parts(ptr, len);
    let parsed = std::str::from_utf8(bytes)
        .map_err(|e| format!("template JSON is not UTF-8: {e}"))
        .and_then(template_from_json);
    match parsed {
        Ok(t) => Box::into_raw(Box::new(t)),
        Err(e) => {
            set_error(e);
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `tmpl` 必须来自 `hook_template_load` 且未被释放过。
#[no_mangle]
pub unsafe extern "C" fn hook_template_free(tmpl: *mut Template) {
    if !tmpl.is_null() {
        drop(Box::from_raw(tmpl));
    }
}

/// 原地改写 init segment（enca → 原始编码，sinf / pssh → free）。
///
/// # Safety
/// `ptr` 必须指向 `len` 字节的可写内存。
#[no_mangle]
pub unsafe extern "C" fn hook_patch_init(ptr: *mut u8, len: usize) {
    patch_init_in_place(std::slice::from_raw_parts_mut(ptr, len));
}

/// 原地解密一个 fragment (moof + mdat)，成功返回 1，失败返回 0。
///
/// # Safety
/// `tmpl` 为有效模板句柄，`ptr` 必须指向 `len` 字节的可写内存。
#[no_mangle]
pub unsafe extern "C" fn hook_decrypt_fragment(tmpl: *const Template, ptr: *mut u8, len: usize) -> u32 {
    if tmpl.is_null() {
        set_error("null template".into());
        return 0;
    }
    match decrypt_fragment_in_place(std::slice::from_raw_parts_mut(ptr, len), &*tmpl) {
        Ok(()) => 1,
        Err(e) => {
            set_error(e);
            0
        }
    }
}
