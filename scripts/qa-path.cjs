const path=require('node:path');
// Rust canonicalize adds the extended Windows prefix after relocation.
module.exports=value=>path.resolve(value.replace(/^\\\\\?\\/,'')).toLowerCase();
