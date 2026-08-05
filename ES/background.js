(function () {
  'use strict';

  chrome.runtime.onInstalled.addListener(function (details) {
    if (!details || details.reason !== 'install') return;

    chrome.tabs.create({
      url: chrome.runtime.getURL('welcome.html'),
    });
  });
})();
