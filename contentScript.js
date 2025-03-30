// Listen for messages from popup
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.action === "injectButtons") {
    injectTradingButtons();
    sendResponse({success: true});
  } else if (request.action === "updateSettings") {
    // Update settings from popup if needed
    sendResponse({success: true});
  }
  return true;
});

// Automatically inject trading buttons when page loads
document.addEventListener('DOMContentLoaded', function() {
  injectTradingButtons();
});

// In case the document is already loaded
if (document.readyState === 'interactive' || document.readyState === 'complete') {
  injectTradingButtons();
}

// Function to inject trading buttons into the page
function injectTradingButtons() {
  // Check if buttons already exist
  if (document.getElementById('openalgo-controls')) {
    return;
  }
  
  // Check if we're on the OpenAlgo dashboard page and position differently
  const isOpenAlgoDashboard = window.location.href.includes('127.0.0.1:5000/dashboard');
  
  // Create container for buttons
  const container = document.createElement('div');
  container.id = 'openalgo-controls';
  container.className = 'openalgo-controls-container';
  
  // Add draggable functionality
  makeDraggable(container);
  
  // Create buttons
  const buttons = [
    { id: 'le-button', text: 'LE', color: 'success', action: 'longEntry', tooltip: 'Long Entry' },
    { id: 'lx-button', text: 'LX', color: 'warning', action: 'longExit', tooltip: 'Long Exit' },
    { id: 'se-button', text: 'SE', color: 'error', action: 'shortEntry', tooltip: 'Short Entry' },
    { id: 'sx-button', text: 'SX', color: 'info', action: 'shortExit', tooltip: 'Short Exit' }
  ];
  
  // Create buttons container
  const buttonsContainer = document.createElement('div');
  buttonsContainer.className = 'openalgo-buttons-row';
  
  buttons.forEach(button => {
    const btn = document.createElement('button');
    btn.id = button.id;
    btn.textContent = button.text;
    btn.className = `openalgo-button btn-${button.color}`;
    btn.setAttribute('title', button.tooltip);
    btn.addEventListener('click', () => handleButtonClick(button.action));
    buttonsContainer.appendChild(btn);
  });
  
  // Add settings icon to the buttons container
  const settingsIcon = document.createElement('button');
  settingsIcon.className = 'openalgo-settings-icon';
  settingsIcon.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
      <circle cx="8" cy="4" r="1.5"/>
      <circle cx="8" cy="8" r="1.5"/>
      <circle cx="8" cy="12" r="1.5"/>
    </svg>
  `;
  settingsIcon.addEventListener('click', toggleSettings);
  settingsIcon.setAttribute('title', 'OpenAlgo Settings');
  buttonsContainer.appendChild(settingsIcon);
  
  // Add the buttons container to the main container
  container.appendChild(buttonsContainer);
  
  // Create settings panel
  const settingsPanel = document.createElement('div');
  settingsPanel.id = 'openalgo-settings-panel';
  settingsPanel.className = 'openalgo-settings-panel hidden';
  
  // Make sure settings panel receives all mouse events
  settingsPanel.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  
  // Load settings from storage
  chrome.storage.sync.get(['hostUrl', 'apiKey', 'symbol', 'exchange', 'product', 'quantity'], function(settings) {
    settingsPanel.innerHTML = `
      <div class="card-body p-3">
        <h3 class="card-title text-xs">Settings</h3>
        <div class="settings-form">
          <div class="form-group">
            <label for="hostUrl">Host URL</label>
            <input type="text" id="hostUrl" value="${settings.hostUrl || 'http://127.0.0.1:5000'}" class="input input-bordered input-xs" placeholder="Host URL">
          </div>
          <div class="form-group">
            <label for="apiKey">API Key</label>
            <input type="text" id="apiKey" value="${settings.apiKey || ''}" class="input input-bordered input-xs" placeholder="API Key">
          </div>
          <div class="form-group">
            <label for="symbol">Symbol</label>
            <input type="text" id="symbol" value="${settings.symbol || ''}" class="input input-bordered input-xs" placeholder="Symbol">
          </div>
          <div class="form-group">
            <label for="exchange">Exchange</label>
            <select id="exchange" class="select select-bordered select-xs">
              <option value="NSE" ${settings.exchange === 'NSE' ? 'selected' : ''}>NSE</option>
              <option value="BSE" ${settings.exchange === 'BSE' ? 'selected' : ''}>BSE</option>
              <option value="BFO" ${settings.exchange === 'BFO' ? 'selected' : ''}>BFO</option>
              <option value="NFO" ${settings.exchange === 'NFO' ? 'selected' : ''}>NFO</option>
              <option value="MCX" ${settings.exchange === 'MCX' ? 'selected' : ''}>MCX</option>
              <option value="CDS" ${settings.exchange === 'CDS' ? 'selected' : ''}>CDS</option>
            </select>
          </div>
          <div class="form-group">
            <label for="product">Product</label>
            <select id="product" class="select select-bordered select-xs">
              <option value="MIS" ${settings.product === 'MIS' ? 'selected' : ''}>MIS</option>
              <option value="NRML" ${settings.product === 'NRML' ? 'selected' : ''}>NRML</option>
              <option value="CNC" ${settings.product === 'CNC' ? 'selected' : ''}>CNC</option>
            </select>
          </div>
          <div class="form-group">
            <label for="quantity">Quantity</label>
            <input type="number" id="quantity" value="${settings.quantity || ''}" class="input input-bordered input-xs" placeholder="Quantity">
          </div>
          <button id="saveSettings" class="btn btn-primary btn-xs w-full mt-2">Save</button>
        </div>
      </div>
    `;
    
    // Attach event listeners to all inputs to stop propagation
    const inputs = settingsPanel.querySelectorAll('input, select');
    inputs.forEach(input => {
      input.addEventListener('mousedown', (e) => {
        e.stopPropagation();
      });
      
      input.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    });
    
    // Save settings button handler
    settingsPanel.querySelector('#saveSettings').addEventListener('click', function(e) {
      e.stopPropagation();
      
      const newSettings = {
        hostUrl: settingsPanel.querySelector('#hostUrl').value,
        apiKey: settingsPanel.querySelector('#apiKey').value,
        symbol: settingsPanel.querySelector('#symbol').value,
        exchange: settingsPanel.querySelector('#exchange').value,
        product: settingsPanel.querySelector('#product').value,
        quantity: settingsPanel.querySelector('#quantity').value
      };
      
      chrome.storage.sync.set(newSettings, function() {
        showNotification('Settings saved successfully!', 'success');
        toggleSettings();
      });
    });
  });
  
  container.appendChild(settingsPanel);
  
  // Position the container differently on the OpenAlgo dashboard
  if (isOpenAlgoDashboard) {
    container.style.top = '20px';
    container.style.right = '20px';
    container.style.left = 'auto';
    
    // Wait for the dashboard to fully load before adding
    setTimeout(() => {
      document.body.appendChild(container);
    }, 1000);
  } else {
    // Default position for other sites
    container.style.top = '100px';
    container.style.left = '20px';
    document.body.appendChild(container);
  }
}

// Toggle settings panel
function toggleSettings() {
  const settingsPanel = document.getElementById('openalgo-settings-panel');
  settingsPanel.classList.toggle('hidden');
}

// Make an element draggable
function makeDraggable(element) {
  let isDragging = false;
  let offsetX, offsetY;
  
  element.style.position = 'fixed';
  element.style.zIndex = '10000';
  
  // Add handle for dragging
  const handle = document.createElement('div');
  handle.className = 'openalgo-drag-handle';
  element.appendChild(handle);
  
  element.addEventListener('mousedown', startDrag);
  
  function startDrag(e) {
    // Don't start dragging if clicked on a form element or the settings panel
    if (e.target.tagName === 'INPUT' || 
        e.target.tagName === 'SELECT' || 
        e.target.tagName === 'BUTTON' || 
        e.target.closest('#openalgo-settings-panel')) {
      return;
    }
    
    isDragging = true;
    offsetX = e.clientX - element.getBoundingClientRect().left;
    offsetY = e.clientY - element.getBoundingClientRect().top;
    
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', stopDrag);
    
    // Prevent text selection during drag
    e.preventDefault();
  }
  
  function drag(e) {
    if (isDragging) {
      element.style.left = (e.clientX - offsetX) + 'px';
      element.style.top = (e.clientY - offsetY) + 'px';
    }
  }
  
  function stopDrag() {
    isDragging = false;
    document.removeEventListener('mousemove', drag);
    document.removeEventListener('mouseup', stopDrag);
  }
}

// Handle button clicks and API calls
function handleButtonClick(action) {
  chrome.storage.sync.get(['hostUrl', 'apiKey', 'symbol', 'exchange', 'product', 'quantity'], function(settings) {
    if (!settings.hostUrl || !settings.apiKey || !settings.symbol || !settings.exchange || !settings.product || !settings.quantity) {
      showNotification('Error: Please complete all settings first!', 'error');
      toggleSettings(); // Show settings panel if settings are incomplete
      return;
    }
    
    switch (action) {
      case 'longEntry':
        placeOrder('BUY', settings);
        break;
      case 'longExit':
        placeSmartOrder('BUY', settings);
        break;
      case 'shortEntry':
        placeOrder('SELL', settings);
        break;
      case 'shortExit':
        placeSmartOrder('SELL', settings);
        break;
    }
  });
}

// Place a regular order (LE or SE)
function placeOrder(action, settings) {
  const url = `${settings.hostUrl}/api/v1/placeorder`;
  
  const data = {
    apikey: settings.apiKey,
    strategy: "Chrome",
    symbol: settings.symbol,
    action: action,
    exchange: settings.exchange,
    pricetype: "MARKET",
    product: settings.product,
    quantity: settings.quantity
  };
  
  makeApiCall(url, data, action === 'BUY' ? 'Long Entry' : 'Short Entry');
}

// Place a smart order (LX or SX)
function placeSmartOrder(action, settings) {
  const url = `${settings.hostUrl}/api/v1/placesmartorder`;
  
  const data = {
    apikey: settings.apiKey,
    strategy: "chrome",
    exchange: settings.exchange,
    symbol: settings.symbol,
    action: action,
    product: settings.product,
    pricetype: "MARKET",
    quantity: "0",
    position_size: "0"
  };
  
  makeApiCall(url, data, action === 'BUY' ? 'Long Exit' : 'Short Exit');
}

// Make API call to OpenAlgo
function makeApiCall(url, data, actionText) {
  // Show loading indicator
  const loadingNotification = showNotification(`Processing ${actionText}...`, 'info', true);
  
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  })
  .then(response => response.json())
  .then(data => {
    // Remove loading notification
    if (loadingNotification) {
      loadingNotification.remove();
    }
    
    if (data.status === 'success') {
      showNotification(`${actionText} successful!`, 'success');
    } else {
      showNotification(`Error: ${data.message || 'Unknown error'}`, 'error');
    }
  })
  .catch(error => {
    // Remove loading notification
    if (loadingNotification) {
      loadingNotification.remove();
    }
    
    showNotification(`API Error: ${error.message}`, 'error');
  });
}

// Show notification on the page
function showNotification(message, type, isPersistent = false) {
  const notification = document.createElement('div');
  notification.className = `openalgo-notification ${type}`;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  if (!isPersistent) {
    setTimeout(() => {
      notification.classList.add('fadeOut');
      setTimeout(() => {
        notification.remove();
      }, 500);
    }, 3000);
  }
  
  return notification;
}

// Inject CSS for buttons
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    /* Scope all styles to avoid affecting OpenAlgo dashboard */
    .openalgo-controls-container {
      display: flex;
      flex-direction: column;
      padding: 3px;
      background-color: rgba(255, 255, 255, 0.95);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      max-width: 200px;
      position: fixed;
      z-index: 10000;
      transition: box-shadow 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      box-sizing: border-box;
    }
    
    .openalgo-controls-container *, .openalgo-controls-container *::before, .openalgo-controls-container *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    .openalgo-controls-container:hover {
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }
    
    .openalgo-buttons-row {
      display: flex;
      gap: 2px;
      align-items: center;
      justify-content: center;
      padding: 2px;
    }
    
    .openalgo-drag-handle {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background-color: #d1d5db;
      border-radius: 3px 3px 0 0;
      cursor: move;
    }
    
    .openalgo-drag-handle:hover {
      background-color: #9ca3af;
    }
    
    .openalgo-button {
      font-weight: bold;
      min-width: 28px;
      cursor: pointer;
      border: none;
      padding: 3px 6px;
      border-radius: 3px;
      color: white;
      text-transform: uppercase;
      font-size: 0.7rem;
      transition: all 0.15s ease;
    }
    
    .openalgo-button:hover {
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
    }
    
    .openalgo-button.btn-success {
      background-color: #36D399;
    }
    
    .openalgo-button.btn-warning {
      background-color: #FBBD23;
      color: #1f2937;
    }
    
    .openalgo-button.btn-error {
      background-color: #F87272;
    }
    
    .openalgo-button.btn-info {
      background-color: #3ABFF8;
    }
    
    .openalgo-settings-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      background: #f2f2f2;
      border: 1px solid #d1d5db;
      border-radius: 3px;
      cursor: pointer;
      color: #1f2937;
      transition: all 0.2s ease;
      margin-left: 2px;
    }
    
    .openalgo-settings-icon:hover {
      background-color: #e5e7eb;
    }
    
    .openalgo-settings-panel {
      position: absolute;
      top: 100%;
      right: 0;
      width: 250px;
      background-color: white;
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      margin-top: 4px;
      z-index: 10001;
      animation: slideDown 0.2s ease;
      pointer-events: auto;
    }
    
    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-5px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .openalgo-settings-panel.hidden {
      display: none;
    }
    
    .openalgo-controls-container .settings-form {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    
    .openalgo-controls-container .form-group {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    
    .openalgo-controls-container .form-group label {
      font-size: 0.7rem;
      color: #374151;
      font-weight: 600;
    }
    
    .openalgo-controls-container .form-group input, 
    .openalgo-controls-container .form-group select {
      padding: 3px 6px;
      border: 1px solid #d1d5db;
      border-radius: 3px;
      font-size: 0.75rem;
      transition: all 0.2s ease;
      background-color: white;
      z-index: 10002;
      position: relative;
      width: 100%;
      height: auto;
    }
    
    .openalgo-controls-container .form-group input:focus, 
    .openalgo-controls-container .form-group select:focus {
      outline: none;
      border-color: #570df8;
      box-shadow: 0 0 0 1px rgba(87, 13, 248, 0.2);
    }
    
    .openalgo-controls-container .btn {
      display: inline-flex;
      cursor: pointer;
      align-items: center;
      justify-content: center;
      text-align: center;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      border: none;
    }
    
    .openalgo-controls-container .btn-primary {
      background-color: #570df8;
      color: white;
    }
    
    .openalgo-controls-container .btn-primary:hover {
      background-color: #4506cb;
    }
    
    .openalgo-controls-container .btn-xs {
      height: 1.5rem;
      padding-left: 0.5rem;
      padding-right: 0.5rem;
      font-size: 0.7rem;
    }
    
    .openalgo-controls-container .w-full {
      width: 100%;
    }
    
    .openalgo-controls-container .mt-2 {
      margin-top: 0.5rem;
    }
    
    .openalgo-controls-container .card-body {
      padding: 0.5rem;
    }
    
    .openalgo-controls-container .p-3 {
      padding: 0.75rem;
    }
    
    .openalgo-controls-container .text-xs {
      font-size: 0.7rem;
    }
    
    .openalgo-controls-container .input-xs, 
    .openalgo-controls-container .select-xs {
      height: 1.5rem;
      font-size: 0.7rem;
      padding: 0 0.5rem;
    }
    
    .openalgo-controls-container .input-bordered, 
    .openalgo-controls-container .select-bordered {
      border: 1px solid #d1d5db;
    }
    
    .openalgo-controls-container .card-title {
      margin-bottom: 0.5rem;
      font-weight: 700;
    }
    
    .openalgo-controls-container .hidden {
      display: none;
    }
    
    .openalgo-notification {
      position: fixed;
      bottom: 1rem;
      right: 1rem;
      padding: 0.5rem 0.75rem;
      border-radius: 3px;
      color: white;
      font-weight: bold;
      z-index: 10001;
      opacity: 1;
      transition: all 0.3s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      max-width: 250px;
      font-size: 0.8rem;
      animation: slideIn 0.2s ease;
    }
    
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateX(10px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    
    .openalgo-notification.success {
      background-color: #36D399;
      border-left: 3px solid #2bb37f;
    }
    
    .openalgo-notification.error {
      background-color: #F87272;
      border-left: 3px solid #e75757;
    }
    
    .openalgo-notification.info {
      background-color: #3ABFF8;
      border-left: 3px solid #0d99ff;
    }
    
    .openalgo-notification.fadeOut {
      opacity: 0;
      transform: translateX(10px);
    }
  `;
  
  document.head.appendChild(style);
}

// Inject styles on content script load
injectStyles();
