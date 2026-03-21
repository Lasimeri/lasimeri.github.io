// config.js — Quake II browser port configuration

var QII = QII || {};

QII.DEMO_EXE_URL = 'https://github.com/Lasimeri/qwasm2-assets/releases/download/v1.0/q2-314-demo-x86.exe';

// SHA-256 of the extracted pak0.pak (demo version)
QII.PAK0_SHA256 = 'cae257182f34d3913f3d663e1d7cf865d668feda6af393d4ecf3e9e408b48d09';

// SHA-256 of the demo exe itself
QII.EXE_SHA256 = '7ace5a43983f10d6bdc9d9b6e17a1032ba6223118d389bd170df89b945a04a1e';

// Path inside the self-extracting ZIP where pak0.pak lives
QII.PAK_PATH_IN_EXE = 'Install/Data/baseq2/pak0.pak';

QII.RENDERERS = {
  gles3: { name: 'WebGL 2 (GLES 3.x)', args: ['+set', 'vid_renderer', 'gles3'] },
  gl1:   { name: 'WebGL 1 (GL1 via GL4ES)', args: ['+set', 'vid_renderer', 'gl1'] },
  soft:  { name: 'Software', args: ['+set', 'vid_renderer', 'soft'] }
};

QII.DEFAULT_RENDERER = 'gles3';

QII.ENGINE_PATH = 'engine/';
