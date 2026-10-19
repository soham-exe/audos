use ed25519_dalek::{SigningKey, Signer};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Sha256, Digest};
use std::env;
use std::fs;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: sign_helper <privkey_b64> <db_file> <sig_out>");
        std::process::exit(1);
    }

    let privkey_bytes = STANDARD.decode(&args[1]).expect("bad privkey base64");
    let privkey_arr: [u8; 32] = privkey_bytes.try_into().expect("privkey must be 32 bytes");
    let signing_key = SigningKey::from_bytes(&privkey_arr);

    let msg = fs::read_to_string(&args[2]).expect("cannot read DB");
    
    // Normalize: strip BOM, standardize line endings, trim whitespace
    let msg = msg.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let msg = msg.trim();

    // Hash the normalized string
    let mut hasher = Sha256::new();
    hasher.update(msg.as_bytes());
    let hash = hasher.finalize();

    // Sign the 32-byte hash (not the raw text)
    let signature = signing_key.sign(&hash);

    fs::write(&args[3], STANDARD.encode(signature.to_bytes())).expect("cannot write sig");

    println!("✓ Signed {} → {}", args[2], args[3]);
}