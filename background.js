// background.js - Service worker to handle API calls from content script
// This bypasses CORS restrictions by making requests from the extension context

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'placeOrder') {
    // Make API call from background script (bypasses CORS)
    const { url, orderData } = request;

    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderData)
    })
    .then(response => {
      if (!response.ok) {
        return response.json().then(errorData => {
          throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
        });
      }
      return response.json();
    })
    .then(data => {
      sendResponse({ success: true, data: data });
    })
    .catch(error => {
      console.error('API Error:', error);
      sendResponse({ success: false, error: error.message });
    });
    
    return true; // Keep message channel open for async response
  }
});

// Optional: Listen for extension installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('OpenAlgo Extension installed');
});
