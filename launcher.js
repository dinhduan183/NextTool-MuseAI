// Chạy server.js và tự khởi động lại khi server thoát với mã 42 (sau khi cập nhật phiên bản mới).
const { spawn } = require('child_process');
const path = require('path');

const RESTART_CODE = 42;
let firstRun = true;

function start() {
  const env = { ...process.env, TM_LAUNCHER: '1' };
  if (!firstRun) env.NO_OPEN = '1'; // khởi động lại thì không mở thêm tab trình duyệt
  firstRun = false;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'inherit', env });
  const forward = (sig) => () => child.kill(sig);
  const onInt = forward('SIGINT'), onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  child.on('exit', (code) => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (code === RESTART_CODE) {
      console.log('Đang khởi động lại với phiên bản mới…');
      start();
    } else {
      process.exit(code || 0);
    }
  });
}
start();
