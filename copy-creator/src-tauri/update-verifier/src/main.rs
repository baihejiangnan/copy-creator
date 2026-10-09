#[path = "../../src/update_signature.rs"]
mod update_signature;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        eprintln!("Usage: copy-creator-update-verifier <package> <signature-file>");
        std::process::exit(2);
    }
    let signature = std::fs::read_to_string(&args[1]).unwrap_or_default();
    match update_signature::verify_file(std::path::Path::new(&args[0]), &signature, None) {
        Ok(_) => println!("Signature verified by the client verifier"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
