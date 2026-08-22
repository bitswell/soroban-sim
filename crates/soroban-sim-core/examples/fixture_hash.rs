use sha2::{Digest, Sha256};

fn main() -> anyhow::Result<()> {
    let output = soroban_sim_core::run_fixture()?;
    let digest: [u8; 32] = Sha256::digest(&output).into();
    println!("len={}", output.len());
    println!("sha256={}", hex::encode(digest));
    Ok(())
}
