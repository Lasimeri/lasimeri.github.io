use wasm_bindgen::prelude::*;
use pgp::composed::{
    KeyType, SecretKeyParamsBuilder, SubkeyParamsBuilder, EncryptionCaps,
    Message, MessageBuilder, SignedSecretKey, SignedPublicKey,
    Deserializable, ArmorOptions,
};
use pgp::crypto::{sym::SymmetricKeyAlgorithm, hash::HashAlgorithm};
use pgp::types::{CompressionAlgorithm, Password, KeyDetails};
use rand::thread_rng;
use smallvec::smallvec;

#[wasm_bindgen]
pub fn pgp_keygen(name: &str, email: &str, passphrase: &str) -> Result<String, JsError> {
    let mut rng = thread_rng();

    let mut key_params = SecretKeyParamsBuilder::default();
    key_params
        .key_type(KeyType::Rsa(4096))
        .can_certify(true)
        .can_sign(true)
        .primary_user_id(format!("{name} <{email}>"))
        .preferred_symmetric_algorithms(smallvec![
            SymmetricKeyAlgorithm::AES256,
            SymmetricKeyAlgorithm::AES192,
            SymmetricKeyAlgorithm::AES128,
        ])
        .preferred_hash_algorithms(smallvec![
            HashAlgorithm::Sha512,
            HashAlgorithm::Sha384,
            HashAlgorithm::Sha256,
        ])
        .preferred_compression_algorithms(smallvec![
            CompressionAlgorithm::ZLIB,
            CompressionAlgorithm::ZIP,
        ])
        .subkeys(vec![
            SubkeyParamsBuilder::default()
                .key_type(KeyType::Rsa(4096))
                .can_encrypt(EncryptionCaps::All)
                .build()
                .map_err(|e| JsError::new(&format!("subkey params: {e}")))?,
        ]);

    let secret_key_params = key_params
        .build()
        .map_err(|e| JsError::new(&format!("key params: {e}")))?;

    let signed_secret_key: SignedSecretKey = secret_key_params
        .generate(&mut rng)
        .map_err(|e| JsError::new(&format!("keygen: {e}")))?;

    let signed_public_key: SignedPublicKey = signed_secret_key.to_public_key();
    let fp = format!("{:X}", signed_public_key.fingerprint());

    let pub_armored = signed_public_key
        .to_armored_string(ArmorOptions::default())
        .map_err(|e| JsError::new(&format!("armor pub: {e}")))?;

    let sec_armored = signed_secret_key
        .to_armored_string(ArmorOptions::default())
        .map_err(|e| JsError::new(&format!("armor sec: {e}")))?;

    fn json_escape(s: &str) -> String {
        s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r")
    }
    Ok(format!(
        r#"{{"public":"{}","secret":"{}","fingerprint":"{}"}}"#,
        json_escape(&pub_armored), json_escape(&sec_armored), fp
    ))
}

#[wasm_bindgen]
pub fn pgp_encrypt(plaintext: &[u8], armored_pubkey: &str) -> Result<Vec<u8>, JsError> {
    let mut rng = thread_rng();

    let (pubkey, _) = SignedPublicKey::from_armor_single(
        std::io::Cursor::new(armored_pubkey)
    ).map_err(|e| JsError::new(&format!("parse pubkey: {e}")))?;

    let enc_subkey = pubkey.public_subkeys.first()
        .ok_or_else(|| JsError::new("no encryption subkey found"))?;

    let mut builder = MessageBuilder::from_bytes("msg", plaintext.to_vec())
        .seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);

    builder
        .encrypt_to_key(&mut rng, enc_subkey)
        .map_err(|e| JsError::new(&format!("encrypt: {e}")))?;

    let encrypted = builder
        .to_vec(&mut rng)
        .map_err(|e| JsError::new(&format!("serialize: {e}")))?;

    Ok(encrypted)
}

#[wasm_bindgen]
pub fn pgp_decrypt(encrypted_data: &[u8], armored_seckey: &str, passphrase: &str) -> Result<Vec<u8>, JsError> {
    let (seckey, _) = SignedSecretKey::from_armor_single(
        std::io::Cursor::new(armored_seckey)
    ).map_err(|e| JsError::new(&format!("parse seckey: {e}")))?;

    let message = Message::from_bytes(encrypted_data)
        .map_err(|e| JsError::new(&format!("parse message: {e}")))?;

    let pw: Password = if passphrase.is_empty() {
        Password::empty()
    } else {
        passphrase.into()
    };

    let mut decrypted = message
        .decrypt(&pw, &seckey)
        .map_err(|e| JsError::new(&format!("decrypt: {e}")))?;

    let plaintext = decrypted
        .as_data_vec()
        .map_err(|e| JsError::new(&format!("extract data: {e}")))?;

    Ok(plaintext)
}

#[wasm_bindgen]
pub fn pgp_fingerprint(armored_pubkey: &str) -> Result<String, JsError> {
    let (pubkey, _) = SignedPublicKey::from_armor_single(
        std::io::Cursor::new(armored_pubkey)
    ).map_err(|e| JsError::new(&format!("parse pubkey: {e}")))?;

    Ok(format!("{:X}", pubkey.fingerprint()))
}
