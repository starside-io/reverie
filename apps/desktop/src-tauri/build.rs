fn main() {
    // scripts/bundle.mjs writes the fingerprint of the host it bundles. The
    // app compiles it in, so it can tell a host running this code from one
    // running older code. A build without a bundle has none.
    println!("cargo:rerun-if-changed=fingerprint");
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    if let Ok(value) = std::fs::read_to_string(std::path::Path::new(&dir).join("fingerprint")) {
        println!("cargo:rustc-env=REVERIE_FINGERPRINT={}", value.trim());
    }
    tauri_build::build()
}
