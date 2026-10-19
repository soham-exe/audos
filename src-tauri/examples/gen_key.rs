use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use base64::{engine::general_purpose::STANDARD, Engine};

fn main() {
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let verifying_key = signing_key.verifying_key();

    let secret_bytes = signing_key.to_bytes();
    let public_bytes = verifying_key.to_bytes();

    println!("# ── PRIVATE KEY (KEEP SECRET, NEVER COMMIT) ──");
    println!("{}", STANDARD.encode(secret_bytes));
    println!();
    println!("# ── PUBLIC KEY (paste into lyrics.rs as EXPECTED_PUBKEY_B64) ──");
    println!("{}", STANDARD.encode(public_bytes));
}