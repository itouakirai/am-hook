use std::sync::OnceLock;
use temari::rounds::Template;
use temari::template::template_from_json;

pub const FIXED_TEMPLATE_JSON: &str = include_str!("fixed_template.json");

static FIXED_TEMPLATE: OnceLock<Template> = OnceLock::new();

/// 获取本地内嵌的固定模板（对应 skd://itunes.apple.com/P000000000/s1/e1，专供 fragment 1 解密）
pub fn get_fixed_template() -> &'static Template {
    FIXED_TEMPLATE.get_or_init(|| {
        template_from_json(FIXED_TEMPLATE_JSON)
            .expect("Failed to initialize embedded fixed template for fragment 1")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedded_template_loads() {
        let tmpl = get_fixed_template();
        assert_eq!(tmpl.ctx.len(), temari::rounds::CTX_SIZE);
    }
}
