document.addEventListener('DOMContentLoaded', function() {
  // Nothing to do in the popup since all functionality is now in the content script
  // The trading buttons are automatically injected into the page
  // Settings are managed through the vertical dots menu directly on the injected buttons
  
  // Show status message
  const statusEl = document.querySelector('.status-text');
  if (statusEl) {
    statusEl.textContent = "Trading buttons are ready to use";
    statusEl.classList.add('success');
  }
});
