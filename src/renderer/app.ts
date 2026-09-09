const statusElement = document.querySelector<HTMLElement>('#status');
const versionElement = document.querySelector<HTMLElement>('#version');

if (statusElement !== null && versionElement !== null) {
  window.desktopApi.getRuntimeInfo()
    .then((runtimeInfo) => {
      statusElement.textContent = 'Ready — no automation loop is running.';
      versionElement.textContent = `Version ${runtimeInfo.version}`;
    })
    .catch(() => {
      statusElement.textContent = 'Ready';
      versionElement.textContent = 'Runtime information unavailable';
    });
}
