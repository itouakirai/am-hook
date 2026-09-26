package puppyready

// This file is a focused Go port of the three pyplayready packages used by
// apple_music_playready_python.py: Device, PSSH and Cdm. It intentionally
// keeps only the request/challenge and XMR license-decryption path needed by
// that example. No third-party Go module is required.

import (
	"bytes"
	"crypto/aes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	clientVersion = "10.0.16384.10011"
)

var wmrmServerPoint = struct {
	x *big.Int
	y *big.Int
}{
	x: mustBigInt("c8b6af16ee941aadaa5389b4af2c10e356be42af175ef3face93254e7b0b3d9b"),
	y: mustBigInt("982b27b5cb2341326e56aa857dbfd5c634ce2cf9ea74fca8f2af5957efeea562"),
}

type eccKey struct {
	private *ecdsa.PrivateKey
}

func newECCKeyFromPrivateBytes(data []byte) (*eccKey, error) {
	if len(data) < 32 {
		return nil, fmt.Errorf("ECC private key must be at least 32 bytes, got %d", len(data))
	}
	curve := elliptic.P256()
	d := new(big.Int).SetBytes(data[:32])
	if d.Sign() == 0 || d.Cmp(curve.Params().N) >= 0 {
		return nil, errors.New("ECC private key is outside the P-256 scalar range")
	}
	x, y := curve.ScalarBaseMult(d.Bytes())
	return &eccKey{private: &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{Curve: curve, X: x, Y: y},
		D:         d,
	}}, nil
}

func generateECCKey() (*eccKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	return &eccKey{private: key}, nil
}

func (k *eccKey) publicBytes() []byte {
	out := append([]byte{}, utilToBytes(k.private.X)...)
	out = append(out, utilToBytes(k.private.Y)...)
	return out
}

func fixed32Bytes(n *big.Int) []byte {
	out := make([]byte, 32)
	n.FillBytes(out)
	return out
}

// utilToBytes mirrors pyplayready.system.util.Util.to_bytes: minimal big-endian
// bytes, rounded up to an even length.
func utilToBytes(n *big.Int) []byte {
	b := n.Bytes()
	if len(b)%2 != 0 {
		b = append([]byte{0}, b...)
	}
	return b
}

type Device struct {
	groupKey         *eccKey
	encryptionKey    *eccKey
	signingKey       *eccKey
	groupCertificate []byte
}

func LoadDevice(path string) (*Device, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseDevice(data)
}

func ParseDevice(data []byte) (*Device, error) {
	if len(data) < 5 || string(data[:3]) != "PRD" {
		return nil, errors.New("invalid PRD header")
	}
	switch data[3] {
	case 1:
		if len(data) < 9 {
			return nil, errors.New("truncated PRD v1")
		}
		groupKeyLen := int(binary.BigEndian.Uint32(data[4:8]))
		pos := 8
		if pos+groupKeyLen+4 > len(data) {
			return nil, errors.New("invalid PRD v1 group key length")
		}
		groupKey, err := newECCKeyFromPrivateBytes(data[pos : pos+groupKeyLen])
		if err != nil {
			return nil, err
		}
		pos += groupKeyLen
		certLen := int(binary.BigEndian.Uint32(data[pos : pos+4]))
		pos += 4
		if pos+certLen > len(data) {
			return nil, errors.New("invalid PRD v1 certificate length")
		}
		return &Device{groupKey: groupKey, groupCertificate: data[pos : pos+certLen]}, nil
	case 2:
		if len(data) < 212 {
			return nil, errors.New("truncated PRD v2")
		}
		certLen := int(binary.BigEndian.Uint32(data[4:8]))
		pos := 8
		if pos+certLen+192 > len(data) {
			return nil, errors.New("invalid PRD v2 lengths")
		}
		cert := data[pos : pos+certLen]
		pos += certLen
		encryptionKey, err := newECCKeyFromPrivateBytes(data[pos : pos+96])
		if err != nil {
			return nil, err
		}
		signingKey, err := newECCKeyFromPrivateBytes(data[pos+96 : pos+192])
		if err != nil {
			return nil, err
		}
		return &Device{encryptionKey: encryptionKey, signingKey: signingKey, groupCertificate: cert}, nil
	case 3:
		if len(data) < 297 {
			return nil, errors.New("truncated PRD v3")
		}
		groupKey, err := newECCKeyFromPrivateBytes(data[4:100])
		if err != nil {
			return nil, err
		}
		encryptionKey, err := newECCKeyFromPrivateBytes(data[100:196])
		if err != nil {
			return nil, err
		}
		signingKey, err := newECCKeyFromPrivateBytes(data[196:292])
		if err != nil {
			return nil, err
		}
		certLen := int(binary.BigEndian.Uint32(data[292:296]))
		if 296+certLen > len(data) {
			return nil, errors.New("invalid PRD v3 certificate length")
		}
		return &Device{
			groupKey:         groupKey,
			encryptionKey:    encryptionKey,
			signingKey:       signingKey,
			groupCertificate: data[296 : 296+certLen],
		}, nil
	default:
		return nil, fmt.Errorf("unsupported PRD version %d", data[3])
	}
}

type session struct {
	id        string
	xmlKey    *eccKey
	keys      []ContentKey
	openedAt  time.Time
	encryptor *eccKey
	signer    *eccKey
}

type ContentKey struct {
	ID  string
	Key []byte
}

type CDM struct {
	device   *Device
	sessions map[string]*session
}

func NewCDM(device *Device) *CDM {
	return &CDM{device: device, sessions: make(map[string]*session)}
}

func (c *CDM) Open() (string, error) {
	id := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, id); err != nil {
		return "", err
	}
	xmlKey, err := generateECCKey()
	if err != nil {
		return "", err
	}
	sessionID := hex.EncodeToString(id)
	c.sessions[sessionID] = &session{
		id:        sessionID,
		xmlKey:    xmlKey,
		openedAt:  time.Now(),
		encryptor: c.device.encryptionKey,
		signer:    c.device.signingKey,
	}
	return sessionID, nil
}

func (c *CDM) Close(sessionID string) {
	delete(c.sessions, sessionID)
}

func (c *CDM) GetLicenseChallenge(sessionID, wrmHeaderString string) (string, error) {
	sess := c.sessions[sessionID]
	if sess == nil {
		return "", errors.New("invalid CDM session")
	}
	if wrmHeaderString == "" {
		return "", errors.New("empty WRM header")
	}
	version, err := wrmHeaderVersion(wrmHeaderString)
	if err != nil {
		return "", err
	}
	protocolVersion := 1
	switch version {
	case "4.3.0.0":
		protocolVersion = 5
	case "4.2.0.0":
		protocolVersion = 4
	}
	serverData, err := ecc256Encrypt(wmrmServerPoint.x, wmrmServerPoint.y, sess.xmlKey.private.X, sess.xmlKey.private.Y)
	if err != nil {
		return "", err
	}
	clientData, err := c.encryptedClientData(sess)
	if err != nil {
		return "", err
	}
	return buildLicenseChallenge(c.device, sess, wrmHeaderString, protocolVersion, serverData, clientData)
}

func (c *CDM) encryptedClientData(sess *session) ([]byte, error) {
	xmlData := buildClientData(c.device.groupCertificate)
	iv := utilToBytes(sess.xmlKey.private.X)
	if len(iv) < aes.BlockSize {
		return nil, errors.New("generated XML key X coordinate is too short")
	}
	aesIV := iv[:aes.BlockSize]
	aesKey := iv[aes.BlockSize:]
	if len(aesKey) != aes.BlockSize {
		return nil, fmt.Errorf("generated XML AES key has invalid length %d", len(aesKey))
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return nil, err
	}
	padded := pkcs7Pad([]byte(xmlData), aes.BlockSize)
	ciphertext := make([]byte, len(padded))
	previous := append([]byte{}, aesIV...)
	for offset := 0; offset < len(padded); offset += aes.BlockSize {
		current := make([]byte, aes.BlockSize)
		for i := 0; i < aes.BlockSize; i++ {
			current[i] = padded[offset+i] ^ previous[i]
		}
		block.Encrypt(ciphertext[offset:offset+aes.BlockSize], current)
		previous = ciphertext[offset : offset+aes.BlockSize]
	}
	return append(append([]byte{}, aesIV...), ciphertext...), nil
}

func buildClientData(certificateChain []byte) string {
	return `<Data><CertificateChains><CertificateChain> ` +
		base64.StdEncoding.EncodeToString(certificateChain) +
		` </CertificateChain></CertificateChains><Features><Feature Name="AESCBC"></Feature><REE><AESCBC></AESCBC></REE></Features></Data>`
}

func buildLicenseChallenge(d *Device, sess *session, wrmHeaderString string, protocolVersion int, serverData, clientData []byte) (string, error) {
	nonce := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	la := `<LA xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols" Id="SignedData" xml:space="preserve">` +
		fmt.Sprintf(`<Version>%d</Version>`, protocolVersion) +
		`<ContentHeader>` + wrmHeaderString + `</ContentHeader>` +
		`<CLIENTINFO><CLIENTVERSION>` + clientVersion + `</CLIENTVERSION></CLIENTINFO>` +
		`<LicenseNonce>` + base64.StdEncoding.EncodeToString(nonce) + `</LicenseNonce>` +
		fmt.Sprintf(`<ClientTime>%d</ClientTime>`, time.Now().Unix()) +
		`<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#" Type="http://www.w3.org/2001/04/xmlenc#Element">` +
		`<EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"></EncryptionMethod>` +
		`<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
		`<EncryptedKey xmlns="http://www.w3.org/2001/04/xmlenc#">` +
		`<EncryptionMethod Algorithm="http://schemas.microsoft.com/DRM/2007/03/protocols#ecc256"></EncryptionMethod>` +
		`<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><KeyName>WMRMServer</KeyName></KeyInfo>` +
		`<CipherData><CipherValue>` + base64.StdEncoding.EncodeToString(serverData) + `</CipherValue></CipherData>` +
		`</EncryptedKey></KeyInfo>` +
		`<CipherData><CipherValue>` + base64.StdEncoding.EncodeToString(clientData) + `</CipherValue></CipherData>` +
		`</EncryptedData></LA>`

	laDigest := sha256.Sum256([]byte(la))
	signedInfo := `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">` +
		`<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>` +
		`<SignatureMethod Algorithm="http://schemas.microsoft.com/DRM/2007/03/protocols#ecdsa-sha256"></SignatureMethod>` +
		`<Reference URI="#SignedData"><DigestMethod Algorithm="http://schemas.microsoft.com/DRM/2007/03/protocols#sha256"></DigestMethod>` +
		`<DigestValue>` + base64.StdEncoding.EncodeToString(laDigest[:]) + `</DigestValue></Reference></SignedInfo>`
	signedInfoDigest := sha256.Sum256([]byte(signedInfo))
	r, s, err := ecdsa.Sign(rand.Reader, d.signingKey.private, signedInfoDigest[:])
	if err != nil {
		return "", err
	}
	signature := append(fixed32Bytes(r), fixed32Bytes(s)...)
	challenge := `<Challenge xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols/messages">` + la +
		`<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">` + signedInfo +
		`<SignatureValue>` + base64.StdEncoding.EncodeToString(signature) + `</SignatureValue>` +
		`<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><KeyValue><ECCKeyValue><PublicKey>` +
		base64.StdEncoding.EncodeToString(d.signingKey.publicBytes()) +
		`</PublicKey></ECCKeyValue></KeyValue></KeyInfo></Signature></Challenge>`
	_ = sess
	return `<?xml version="1.0" encoding="utf-8"?>` +
		`<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
		`<soap:Body><AcquireLicense xmlns="http://schemas.microsoft.com/DRM/2007/03/protocols"><challenge>` +
		challenge + `</challenge></AcquireLicense></soap:Body></soap:Envelope>`, nil
}

func ecc256Encrypt(publicX, publicY, plaintextX, plaintextY *big.Int) ([]byte, error) {
	curve := elliptic.P256()
	if !curve.IsOnCurve(publicX, publicY) || !curve.IsOnCurve(plaintextX, plaintextY) {
		return nil, errors.New("invalid ECC point")
	}
	var ephemeral *big.Int
	for ephemeral == nil || ephemeral.Sign() == 0 {
		var err error
		ephemeral, err = rand.Int(rand.Reader, curve.Params().N)
		if err != nil {
			return nil, err
		}
	}
	point1X, point1Y := curve.ScalarBaseMult(ephemeral.Bytes())
	sharedX, sharedY := curve.ScalarMult(publicX, publicY, ephemeral.Bytes())
	point2X, point2Y := curve.Add(plaintextX, plaintextY, sharedX, sharedY)
	out := append([]byte{}, utilToBytes(point1X)...)
	out = append(out, utilToBytes(point1Y)...)
	out = append(out, utilToBytes(point2X)...)
	out = append(out, utilToBytes(point2Y)...)
	return out, nil
}

func ecc256Decrypt(privateKey *eccKey, ciphertext []byte) ([]byte, error) {
	curve := elliptic.P256()
	if len(ciphertext) < 128 {
		return nil, fmt.Errorf("ECC ciphertext is too short: %d", len(ciphertext))
	}
	point1X := new(big.Int).SetBytes(ciphertext[0:32])
	point1Y := new(big.Int).SetBytes(ciphertext[32:64])
	point2X := new(big.Int).SetBytes(ciphertext[64:96])
	point2Y := new(big.Int).SetBytes(ciphertext[96:128])
	if !curve.IsOnCurve(point1X, point1Y) || !curve.IsOnCurve(point2X, point2Y) {
		return nil, errors.New("invalid ECC ciphertext point")
	}
	sharedX, sharedY := curve.ScalarMult(point1X, point1Y, privateKey.private.D.Bytes())
	negativeY := new(big.Int).Neg(sharedY)
	negativeY.Mod(negativeY, curve.Params().P)
	decryptedX, _ := curve.Add(point2X, point2Y, sharedX, negativeY)
	return utilToBytes(decryptedX), nil
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	padding := blockSize - len(data)%blockSize
	return append(append([]byte{}, data...), bytes.Repeat([]byte{byte(padding)}, padding)...)
}

type wrmHeaderXML struct {
	Version string `xml:"version,attr"`
}

func wrmHeaderVersion(header string) (string, error) {
	var parsed wrmHeaderXML
	if err := xml.Unmarshal([]byte(header), &parsed); err != nil {
		return "", fmt.Errorf("invalid WRMHEADER XML: %w", err)
	}
	if parsed.Version == "" {
		return "", errors.New("WRMHEADER has no version")
	}
	return parsed.Version, nil
}

type PSSH struct {
	WRMHeaders []string
}

func ParsePSSH(input string) (*PSSH, error) {
	header, err := parsePSSH(input)
	if err != nil {
		return nil, err
	}
	return &PSSH{WRMHeaders: []string{header}}, nil
}

func parsePSSH(input string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(input))
	if err != nil {
		return "", fmt.Errorf("decode PSSH base64: %w", err)
	}
	if len(data) == 0 {
		return "", errors.New("empty PSSH")
	}
	if header, ok, err := parsePSSHBox(data); ok || err != nil {
		return header, err
	}
	// pyplayready distinguishes a PlayReady Header from an Object by the
	// little-endian first uint16.
	if len(data) >= 2 && binary.LittleEndian.Uint16(data[:2]) > 3 {
		return parsePlayreadyHeader(data)
	}
	return parsePlayreadyObject(data)
}

func parsePSSHBox(data []byte) (string, bool, error) {
	if len(data) < 32 || string(data[4:8]) != "pssh" {
		return "", false, nil
	}
	boxLength := int(binary.BigEndian.Uint32(data[:4]))
	if boxLength < 32 || boxLength > len(data) {
		return "", true, errors.New("invalid pssh box length")
	}
	pos := 8
	version := data[pos]
	pos += 4
	if pos+16 > boxLength {
		return "", true, errors.New("truncated pssh system id")
	}
	pos += 16
	if version == 1 {
		if pos+4 > boxLength {
			return "", true, errors.New("truncated pssh key id count")
		}
		count := int(binary.BigEndian.Uint32(data[pos : pos+4]))
		pos += 4
		if pos+count*16 > boxLength {
			return "", true, errors.New("invalid pssh key id count")
		}
		pos += count * 16
	}
	if pos+4 > boxLength {
		return "", true, errors.New("truncated pssh data length")
	}
	dataLength := int(binary.BigEndian.Uint32(data[pos : pos+4]))
	pos += 4
	if pos+dataLength > boxLength {
		return "", true, errors.New("invalid pssh data length")
	}
	boxData := data[pos : pos+dataLength]
	if printableUTF16LE(boxData) {
		header, err := decodeWRMHeader(boxData)
		return header, true, err
	}
	header, err := parsePlayreadyHeader(boxData)
	return header, true, err
}

func parsePlayreadyHeader(data []byte) (string, error) {
	if len(data) < 6 {
		return "", errors.New("truncated PlayReady header")
	}
	count := int(binary.LittleEndian.Uint16(data[4:6]))
	pos := 6
	var headers []string
	for i := 0; i < count; i++ {
		if pos+4 > len(data) {
			return "", errors.New("truncated PlayReady object header")
		}
		objectType := binary.LittleEndian.Uint16(data[pos : pos+2])
		objectLength := int(binary.LittleEndian.Uint16(data[pos+2 : pos+4]))
		pos += 4
		if pos+objectLength > len(data) {
			return "", errors.New("invalid PlayReady object length")
		}
		if objectType == 1 {
			header, err := decodeWRMHeader(data[pos : pos+objectLength])
			if err != nil {
				return "", err
			}
			headers = append(headers, header)
		}
		pos += objectLength
	}
	if len(headers) == 0 {
		return "", errors.New("PlayReady header has no type 1 object")
	}
	return headers[0], nil
}

func parsePlayreadyObject(data []byte) (string, error) {
	if len(data) < 4 {
		return "", errors.New("truncated PlayReady object")
	}
	objectType := binary.LittleEndian.Uint16(data[:2])
	objectLength := int(binary.LittleEndian.Uint16(data[2:4]))
	if objectType != 1 || 4+objectLength > len(data) {
		return "", errors.New("invalid PlayReady object")
	}
	return decodeWRMHeader(data[4 : 4+objectLength])
}

func decodeWRMHeader(data []byte) (string, error) {
	if len(data) >= 2 && data[0] == 0xff && data[1] == 0xfe {
		data = data[2:]
	}
	header, err := decodeUTF16LE(data)
	if err != nil {
		return "", err
	}
	if _, err := wrmHeaderVersion(header); err != nil {
		return "", err
	}
	return header, nil
}

func decodeUTF16LE(data []byte) (string, error) {
	if len(data)%2 != 0 {
		return "", errors.New("UTF-16LE data has odd length")
	}
	words := make([]uint16, len(data)/2)
	for i := range words {
		words[i] = binary.LittleEndian.Uint16(data[i*2 : i*2+2])
	}
	return string(utf16.Decode(words)), nil
}

func printableUTF16LE(data []byte) bool {
	decoded, err := decodeUTF16LE(data)
	if err != nil {
		return false
	}
	for _, r := range decoded {
		if r < 0x20 || r > 0x7e {
			return false
		}
	}
	return true
}

type xmrLicense struct {
	raw     []byte
	objects []*xmrObject
}

type xmrObject struct {
	flags    uint16
	typ      uint16
	length   uint32
	data     []byte
	children []*xmrObject
}

func parseXMRLicense(data []byte) (*xmrLicense, error) {
	if len(data) < 24 || !bytes.Equal(data[:4], []byte{'X', 'M', 'R', 0}) {
		return nil, errors.New("invalid XMR license header")
	}
	objects, err := parseXMRObjects(data[24:])
	if err != nil {
		return nil, err
	}
	return &xmrLicense{raw: append([]byte{}, data...), objects: objects}, nil
}

func parseXMRObjects(data []byte) ([]*xmrObject, error) {
	var objects []*xmrObject
	for pos := 0; pos < len(data); {
		if len(data)-pos < 8 {
			return nil, errors.New("truncated XMR object header")
		}
		flags := binary.BigEndian.Uint16(data[pos : pos+2])
		typ := binary.BigEndian.Uint16(data[pos+2 : pos+4])
		length := binary.BigEndian.Uint32(data[pos+4 : pos+8])
		pos += 8
		if length < 8 || uint64(length-8) > uint64(len(data)-pos) {
			return nil, errors.New("invalid XMR object length")
		}
		payloadLength := int(length - 8)
		payload := data[pos : pos+payloadLength]
		object := &xmrObject{flags: flags, typ: typ, length: length, data: payload}
		if flags == 2 || flags == 3 {
			children, err := parseXMRObjects(payload)
			if err != nil {
				return nil, err
			}
			object.children = children
		}
		objects = append(objects, object)
		pos += payloadLength
	}
	return objects, nil
}

func (license *xmrLicense) findObjects(objectType uint16) []*xmrObject {
	var found []*xmrObject
	var walk func([]*xmrObject)
	walk = func(objects []*xmrObject) {
		for _, object := range objects {
			if object.typ == objectType {
				found = append(found, object)
			}
			walk(object.children)
		}
	}
	walk(license.objects)
	return found
}

func (license *xmrLicense) firstObject(objectType uint16) (*xmrObject, error) {
	objects := license.findObjects(objectType)
	if len(objects) == 0 {
		return nil, fmt.Errorf("XMR object 0x%04x not found", objectType)
	}
	return objects[0], nil
}

type xmrECCDeviceKey struct {
	key []byte
}

type xmrContentKey struct {
	keyID        []byte
	keyType      uint16
	cipherType   uint16
	keyLength    uint16
	encryptedKey []byte
}

type xmrSignature struct {
	signatureDataLength uint16
	signatureData       []byte
}

func parseXMRECCDeviceKey(object *xmrObject) (*xmrECCDeviceKey, error) {
	if len(object.data) < 4 {
		return nil, errors.New("truncated XMR ECC device key")
	}
	keyLength := int(binary.BigEndian.Uint16(object.data[2:4]))
	if len(object.data) < 4+keyLength {
		return nil, errors.New("invalid XMR ECC device key length")
	}
	return &xmrECCDeviceKey{key: object.data[4 : 4+keyLength]}, nil
}

func parseXMRContentKey(object *xmrObject) (*xmrContentKey, error) {
	if len(object.data) < 22 {
		return nil, errors.New("truncated XMR content key")
	}
	keyLength := binary.BigEndian.Uint16(object.data[20:22])
	if len(object.data) < 22+int(keyLength) {
		return nil, errors.New("invalid XMR content key length")
	}
	return &xmrContentKey{
		keyID:        object.data[:16],
		keyType:      binary.BigEndian.Uint16(object.data[16:18]),
		cipherType:   binary.BigEndian.Uint16(object.data[18:20]),
		keyLength:    keyLength,
		encryptedKey: object.data[22 : 22+int(keyLength)],
	}, nil
}

func parseXMRSignature(object *xmrObject) (*xmrSignature, error) {
	if len(object.data) < 4 {
		return nil, errors.New("truncated XMR signature")
	}
	signatureLength := binary.BigEndian.Uint16(object.data[2:4])
	if len(object.data) < 4+int(signatureLength) {
		return nil, errors.New("invalid XMR signature length")
	}
	return &xmrSignature{
		signatureDataLength: signatureLength,
		signatureData:       object.data[4 : 4+int(signatureLength)],
	}, nil
}

func parseXMRAuxiliaryKey(object *xmrObject) ([]byte, error) {
	if len(object.data) < 2 {
		return nil, errors.New("truncated XMR auxiliary key object")
	}
	count := int(binary.BigEndian.Uint16(object.data[:2]))
	pos := 2
	if count < 1 {
		return nil, errors.New("XMR auxiliary key object is empty")
	}
	for i := 0; i < count; i++ {
		if pos+20 > len(object.data) {
			return nil, errors.New("invalid XMR auxiliary key object")
		}
		if i == 0 {
			return append([]byte{}, object.data[pos+4:pos+20]...), nil
		}
		pos += 20
	}
	return nil, errors.New("XMR auxiliary key not found")
}
func (c *CDM) ParseLicense(sessionID string, licenseXML []byte) error {
	sess := c.sessions[sessionID]
	if sess == nil {
		return errors.New("invalid CDM session")
	}
	payloads, err := extractLicensePayloads(licenseXML)
	if err != nil {
		return err
	}
	if len(payloads) == 0 {
		return errors.New("license XML contains no License payload")
	}
	for _, payload := range payloads {
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(payload))
		if err != nil {
			return fmt.Errorf("decode XMR license: %w", err)
		}
		license, err := parseXMRLicense(raw)
		if err != nil {
			return err
		}
		key, err := decryptXMRLicense(license, c.device.encryptionKey)
		if err != nil {
			return err
		}
		sess.keys = append(sess.keys, key)
	}
	return nil
}

func (c *CDM) GetKeys(sessionID string) ([]ContentKey, error) {
	sess := c.sessions[sessionID]
	if sess == nil {
		return nil, errors.New("invalid CDM session")
	}
	return sess.keys, nil
}

func extractLicensePayloads(licenseXML []byte) ([]string, error) {
	decoder := xml.NewDecoder(bytes.NewReader(licenseXML))
	var path []string
	var payloads []string
	var builder strings.Builder
	var capturing bool
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch value := token.(type) {
		case xml.StartElement:
			path = append(path, value.Name.Local)
			if value.Name.Local == "License" && len(path) >= 2 && path[len(path)-2] == "Licenses" {
				capturing = true
				builder.Reset()
			}
		case xml.CharData:
			if capturing {
				builder.Write([]byte(value))
			}
		case xml.EndElement:
			if capturing && value.Name.Local == "License" {
				payloads = append(payloads, strings.TrimSpace(builder.String()))
				capturing = false
			}
			if len(path) > 0 {
				path = path[:len(path)-1]
			}
		}
	}
	return payloads, nil
}

func decryptXMRLicense(license *xmrLicense, encryptionKey *eccKey) (ContentKey, error) {
	deviceObject, err := license.firstObject(0x002a) // ECC_DEVICE_KEY_OBJECT
	if err != nil {
		return ContentKey{}, err
	}
	deviceKey, err := parseXMRECCDeviceKey(deviceObject)
	if err != nil {
		return ContentKey{}, err
	}
	if !bytes.Equal(deviceKey.key, encryptionKey.publicBytes()) {
		return ContentKey{}, errors.New("XMR public encryption key does not match device")
	}

	contentObject, err := license.firstObject(0x000a) // CONTENT_KEY_OBJECT
	if err != nil {
		return ContentKey{}, err
	}
	content, err := parseXMRContentKey(contentObject)
	if err != nil {
		return ContentKey{}, err
	}
	if content.cipherType != 3 && content.cipherType != 4 && content.cipherType != 6 {
		return ContentKey{}, fmt.Errorf("unsupported XMR cipher type %d", content.cipherType)
	}

	decrypted, err := ecc256Decrypt(encryptionKey, content.encryptedKey)
	if err != nil {
		return ContentKey{}, err
	}
	if len(decrypted) < 32 {
		return ContentKey{}, errors.New("decrypted XMR content key is too short")
	}
	integrityKey := decrypted[:16]
	keyBytes := decrypted[16:32]

	auxObject, auxErr := license.firstObject(0x0051) // AUX_KEY_OBJECT
	if auxErr == nil {
		even := make([]byte, 0, (len(decrypted)+1)/2)
		odd := make([]byte, 0, len(decrypted)/2)
		for i, value := range decrypted {
			if i%2 == 0 {
				even = append(even, value)
			} else {
				odd = append(odd, value)
			}
		}
		if len(even) < 16 || len(odd) < 16 {
			return ContentKey{}, errors.New("scalable XMR integrity key is too short")
		}
		integrityKey = even[:16]
		keyBytes = odd[:16]
		if content.cipherType == 6 {
			auxiliaryKey, err := parseXMRAuxiliaryKey(auxObject)
			if err != nil {
				return ContentKey{}, err
			}
			keyBytes, integrityKey, err = unwrapSymmetricContentKey(content, keyBytes, auxiliaryKey)
			if err != nil {
				return ContentKey{}, err
			}
		}
	}

	signatureObject, err := license.firstObject(0x000b) // SIGNATURE_OBJECT
	if err != nil {
		return ContentKey{}, err
	}
	signature, err := parseXMRSignature(signatureObject)
	if err != nil {
		return ContentKey{}, err
	}
	excludedLength := int(signature.signatureDataLength) + 12
	if excludedLength > len(license.raw) {
		return ContentKey{}, errors.New("invalid XMR signature length")
	}
	expectedMAC := computeAESCMAC(integrityKey, license.raw[:len(license.raw)-excludedLength])
	if !bytes.Equal(expectedMAC, signature.signatureData) {
		return ContentKey{}, errors.New("XMR license integrity signature does not match")
	}

	return ContentKey{
		ID:  canonicalUUIDHex(content.keyID),
		Key: append([]byte{}, keyBytes...),
	}, nil
}

func unwrapSymmetricContentKey(content *xmrContentKey, keyBytes, auxiliaryKey []byte) ([]byte, []byte, error) {
	if len(content.encryptedKey) < 176 {
		return nil, nil, errors.New("symmetric scalable XMR content key is too short")
	}
	magicZero := []byte{
		0x7e, 0xe9, 0xed, 0x4a, 0xf7, 0x73, 0x22, 0x4f,
		0x00, 0xb8, 0xea, 0x7e, 0xfb, 0x02, 0x7c, 0xbb,
	}
	rgbKey := make([]byte, 16)
	for i := 0; i < 16; i++ {
		rgbKey[i] = keyBytes[i] ^ magicZero[i]
	}
	ContentKeyPrime, err := aesECBEncrypt(keyBytes, rgbKey)
	if err != nil {
		return nil, nil, err
	}
	uplinkXKey, err := aesECBEncrypt(ContentKeyPrime, auxiliaryKey)
	if err != nil {
		return nil, nil, err
	}
	secondaryKey, err := aesECBEncrypt(keyBytes, content.encryptedKey[128:144])
	if err != nil {
		return nil, nil, err
	}
	embeddedLeafLicense := append([]byte{}, content.encryptedKey[144:]...)
	embeddedLeafLicense, err = aesECBEncrypt(uplinkXKey, embeddedLeafLicense)
	if err != nil {
		return nil, nil, err
	}
	embeddedLeafLicense, err = aesECBEncrypt(secondaryKey, embeddedLeafLicense)
	if err != nil {
		return nil, nil, err
	}
	if len(embeddedLeafLicense) < 32 {
		return nil, nil, errors.New("embedded symmetric XMR leaf license is too short")
	}
	return append([]byte{}, embeddedLeafLicense[16:32]...), append([]byte{}, embeddedLeafLicense[:16]...), nil
}

func aesECBEncrypt(key, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if len(plaintext) == 0 || len(plaintext)%aes.BlockSize != 0 {
		return nil, fmt.Errorf("AES-ECB plaintext length must be a non-zero multiple of %d", aes.BlockSize)
	}
	ciphertext := make([]byte, len(plaintext))
	for offset := 0; offset < len(plaintext); offset += aes.BlockSize {
		block.Encrypt(ciphertext[offset:offset+aes.BlockSize], plaintext[offset:offset+aes.BlockSize])
	}
	return ciphertext, nil
}

func computeAESCMAC(key, message []byte) []byte {
	block, _ := aes.NewCipher(key)
	zero := make([]byte, aes.BlockSize)
	l := make([]byte, aes.BlockSize)
	block.Encrypt(l, zero)
	k1 := cmacDouble(l)
	k2 := cmacDouble(k1)

	var prefix, last []byte
	if len(message) > 0 && len(message)%aes.BlockSize == 0 {
		prefix = message[:len(message)-aes.BlockSize]
		last = xorBlock(message[len(message)-aes.BlockSize:], k1)
	} else {
		padded := append([]byte{}, message...)
		padded = append(padded, 0x80)
		for len(padded)%aes.BlockSize != 0 {
			padded = append(padded, 0)
		}
		prefix = padded[:len(padded)-aes.BlockSize]
		last = xorBlock(padded[len(padded)-aes.BlockSize:], k2)
	}

	previous := make([]byte, aes.BlockSize)
	for offset := 0; offset < len(prefix); offset += aes.BlockSize {
		previous = cmacAbsorb(block, previous, prefix[offset:offset+aes.BlockSize])
	}
	return cmacAbsorb(block, previous, last)
}

func cmacAbsorb(block interface{ Encrypt(dst, src []byte) }, previous, current []byte) []byte {
	out := make([]byte, aes.BlockSize)
	block.Encrypt(out, xorBlock(previous, current))
	return out
}

func cmacDouble(input []byte) []byte {
	out := make([]byte, len(input))
	carry := byte(0)
	for i := len(input) - 1; i >= 0; i-- {
		nextCarry := input[i] >> 7
		out[i] = input[i]<<1 | carry
		carry = nextCarry
	}
	if input[0]&0x80 != 0 {
		out[len(out)-1] ^= 0x87
	}
	return out
}

func xorBlock(left, right []byte) []byte {
	out := make([]byte, aes.BlockSize)
	for i := 0; i < aes.BlockSize; i++ {
		out[i] = left[i] ^ right[i]
	}
	return out
}

func canonicalUUIDHex(raw []byte) string {
	if len(raw) != 16 {
		return hex.EncodeToString(raw)
	}
	out := make([]byte, 16)
	copy(out[0:4], reverseCopy(raw[0:4]))
	copy(out[4:6], reverseCopy(raw[4:6]))
	copy(out[6:8], reverseCopy(raw[6:8]))
	copy(out[8:16], raw[8:16])
	return hex.EncodeToString(out)
}

func reverseCopy(input []byte) []byte {
	out := make([]byte, len(input))
	for i := range input {
		out[len(input)-1-i] = input[i]
	}
	return out
}

func mustBigInt(value string) *big.Int {
	n, ok := new(big.Int).SetString(value, 16)
	if !ok {
		panic("invalid integer constant")
	}
	return n
}
