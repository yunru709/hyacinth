const asar = require("C:\\Users\\74689\\Desktop\\Agent\\hyacinth-desktop\\node_modules\\@electron\\asar\\lib\\asar.js");
asar.createPackage(process.argv[2], process.argv[3]).then(() => console.log('asar ok')).catch(e => { console.error(e); process.exit(1); });
