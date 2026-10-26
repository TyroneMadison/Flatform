// A Blender that fails the way the real one did on 5.2: the script's FLATFORM_ERROR, then Blender's banner on stdout
// and a DeprecationWarning on stderr. Flatform must report the FLATFORM_ERROR text, not the last line printed.
console.log('FLATFORM_ERROR The model could not be placed');
console.error("render/blender_turntable.py:110: DeprecationWarning: 'Material.use_nodes' is expected to be removed in Blender 6.0\n  mat.use_nodes = True");
console.log('Blender 5.2.2 LTS');
process.exit(1);
