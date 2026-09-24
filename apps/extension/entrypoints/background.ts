export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel.
  void browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true });
});
