(() => {
  const reset = document.querySelector('#resetBtn');
  if (!reset) return;
  reset.addEventListener('click', () => {
    window.setTimeout(() => window.location.reload(), 0);
  }, { once: true });
})();
