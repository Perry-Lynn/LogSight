/*
 * LogSight 加密服务模块
 * 提供 AES-256-GCM 对称加密与 Argon2id 密钥派生，用于安全存储 SSH 密码和私钥
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use anyhow::{anyhow, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;

/*
 * 加密服务结构体
 * 主密码通过 Argon2id 派生 256bit 密钥，再用 AES-256-GCM 加解密敏感字段
 */
pub struct CryptoService {
    /* Argon2id 配置实例 */
    argon2: Argon2<'static>,
}

impl Default for CryptoService {
    fn default() -> Self {
        Self::new()
    }
}

impl CryptoService {
    /*
     * 创建加密服务实例
     * Argon2id 参数：m=64MB, t=3次迭代, p=1线程，派生 32 字节密钥
     */
    pub fn new() -> Self {
        let params = Params::new(65536, 3, 1, Some(32))
            .expect("Argon2 参数创建失败（内存成本/迭代次数异常）");
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        Self { argon2 }
    }

    /*
     * 使用用户主密码 + 随机 salt 通过 Argon2id 派生 AES-256 密钥
     * @param master_password 用户输入的主密码字符串
     * @param salt 16字节随机盐，加密时生成、解密时原样读取
     * @return 32字节密钥
     */
    pub fn derive_key(&self, master_password: &str, salt: &[u8]) -> Result<[u8; 32]> {
        let mut key = [0u8; 32];
        self.argon2
            .hash_password_into(master_password.as_bytes(), salt, &mut key)
            .map_err(|e| anyhow!("Argon2id 密钥派生失败: {}", e))?;
        Ok(key)
    }

    /*
     * 加密明文（带随机 nonce + salt）
     * 输出格式：[salt:16字节][nonce:12字节][ciphertext:可变]，Base64封装
     * @param plaintext 待加密原始字节
     * @param master_password 用户主密码
     * @return Base64 封装的加密密文
     */
    pub fn encrypt(&self, plaintext: &[u8], master_password: &str) -> Result<String> {
        // 1. 生成随机 salt 16字节
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);

        // 2. 派生 AES-256 密钥
        let key_bytes = self.derive_key(master_password, &salt)?;
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        let cipher = Aes256Gcm::new(key);

        // 3. 生成随机 nonce 12字节（AES-GCM 要求）
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        // 4. 加密
        let ciphertext = cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| anyhow!("AES-256-GCM 加密失败: {}", e))?;

        // 5. 拼接 [salt][nonce][ciphertext] 后 Base64 编码
        let mut result: Vec<u8> = Vec::with_capacity(16 + 12 + ciphertext.len());
        result.extend_from_slice(&salt);
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);
        Ok(B64.encode(result))
    }

    /*
     * 解密密文（从 Base64 中提取 salt + nonce + ciphertext）
     * @param cipher_b64 由 encrypt 生成的 Base64 密文
     * @param master_password 用户主密码
     * @return 解密后原始字节
     */
    pub fn decrypt(&self, cipher_b64: &str, master_password: &str) -> Result<Vec<u8>> {
        // 1. Base64 解码
        let mut blob = B64
            .decode(cipher_b64.as_bytes())
            .map_err(|e| anyhow!("Base64 解码失败，密文可能损坏: {}", e))?;
        if blob.len() < 16 + 12 + 1 {
            return Err(anyhow!("密文长度过短，数据不完整"));
        }

        // 2. 拆分 [salt 16B][nonce 12B][ciphertext]
        let salt = blob.drain(0..16).collect::<Vec<u8>>();
        let nonce_bytes = blob.drain(0..12).collect::<Vec<u8>>();
        let ciphertext = blob;

        // 3. 派生 AES 密钥
        let key_bytes = self.derive_key(master_password, &salt)?;
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        let cipher = Aes256Gcm::new(key);
        let nonce = Nonce::from_slice(&nonce_bytes);

        // 4. 解密（AES-GCM 会同时验证 MAC，篡改会失败）
        cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|e| anyhow!("AES-256-GCM 解密失败（密码错误或密文被篡改）: {}", e))
    }

    /*
     * 便捷函数：加密字符串并返回密文字符串
     */
    pub fn encrypt_str(&self, plain: &str, master_password: &str) -> Result<String> {
        self.encrypt(plain.as_bytes(), master_password)
    }

    /*
     * 便捷函数：解密密文并转换为 UTF-8 字符串
     */
    pub fn decrypt_str(&self, cipher_b64: &str, master_password: &str) -> Result<String> {
        let bytes = self.decrypt(cipher_b64, master_password)?;
        String::from_utf8(bytes).context("解密后字节无法解析为 UTF-8 字符串")
    }

    /*
     * 生成一个随机的应用级主密码（首次启动使用）
     * 返回 32 字节 hex 字符串
     */
    pub fn generate_app_master_password() -> String {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        hex::encode(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let svc = CryptoService::new();
        let pwd = "KL-is-my-queen-1314";
        let plain = "JCss%6!8";
        let cipher = svc.encrypt_str(plain, pwd).unwrap();
        let restored = svc.decrypt_str(&cipher, pwd).unwrap();
        assert_eq!(restored, plain);
    }

    #[test]
    fn test_wrong_password_fails() {
        let svc = CryptoService::new();
        let cipher = svc.encrypt_str("secret", "right").unwrap();
        assert!(svc.decrypt_str(&cipher, "wrong").is_err());
    }
}
