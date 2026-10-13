'use strict';
// The page never receives the local service token or provider credentials.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab?.url?.startsWith('https://firefly.adobe.com/') || message?.channel !== 'prefire-tryon') return;
  (async () => {
    const routes = {health: '/health', submit: '/jobs', status: '/jobs/' + encodeURIComponent(message.id || '')};
    if (!Object.hasOwn(routes, message.action)) throw new Error('Unknown Try-on action.');
    const {tryonToken} = await chrome.storage.local.get('tryonToken');
    if (!tryonToken) throw new Error('Open Try-on settings and enter the local service token.');
    const response = await fetch('http://127.0.0.1:8765' + routes[message.action], {
      method: message.action === 'submit' ? 'POST' : 'GET',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + tryonToken},
      body: message.action === 'submit' ? JSON.stringify(message.data) : undefined,
      signal: AbortSignal.timeout(45000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Try-on service failed.');
    return data;
  })().then(data => reply({data}), error => reply({error: error.message === 'Failed to fetch'
    ? 'Start the local Try-on service (see README), then resume.' : error.message}));
  return true;
});
