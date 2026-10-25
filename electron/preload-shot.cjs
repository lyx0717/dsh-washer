const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('washerHost', {
  endpoint: { port: 1, token: 'x' },
  state: () => Promise.resolve({ endpoint: { port: 1, token: 'x' }, size: 'normal', skin: 'precision', dark: false }),
  onPrefs: () => {}, onClickThroughChange: () => {}, setPrefs: () => {},
  setReduceMotion: () => {}, notify: () => {}, showMenu: () => {},
});
