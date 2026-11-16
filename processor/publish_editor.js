document.addEventListener('click', async event => {
  const button = event.target.closest('#bulk-upload-clips');
  if (!button || button.disabled) return;
  event.preventDefault();
  const jobId = D.jid;
  const status = document.querySelector('#bulk-upload-state');
  if (!jobId || !status) return;
  button.disabled = true;
  button.textContent = 'Uploading clips…';
  status.textContent = 'Preparing every finished clip for Studio.';
  try {
    const started = await send('/api/local-publish/' + encodeURIComponent(jobId), {});
    let result = started;
    while (result.status === 'uploading') {
      status.textContent = `${result.stage} · ${result.filesDone || 0} of ${result.filesTotal || 0} clips · ${result.progress || 0}%`;
      await new Promise(resolve => setTimeout(resolve, 1500));
      result = await api('/api/local-publish/' + encodeURIComponent(started.publishId || started.id));
    }
    if (result.status !== 'completed') throw new Error(result.error || 'The clips could not be uploaded.');
    status.textContent = 'All finished clips are ready. Open the bulk uploader to review titles and captions.';
    const link = document.createElement('a');
    link.className = 'btn primary';
    link.textContent = 'Open Studio bulk uploader';
    link.href = 'https://studio.gameofkratos.workers.dev/upload?clipBatch=' + encodeURIComponent(result.jobId);
    link.target = '_blank';
    link.rel = 'noopener';
    button.replaceWith(link);
  } catch (error) {
    status.textContent = error.message || 'Upload stopped. Check your connection and try again.';
    button.textContent = 'Try bulk upload again';
    button.disabled = false;
  }
});
