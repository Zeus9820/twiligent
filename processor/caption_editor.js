async function loadCaptionWords(jid, cid) {
  const container = $("#caption-words"), button = $("#save-caption-words");
  try {
    const path = "/api/local-captions/" + encodeURIComponent(jid) + "/" + encodeURIComponent(cid);
    const data = await api(path);
    if (D.jid !== jid || D.cid !== cid || !container?.isConnected) return;
    if (!data.words.length) { container.textContent = "No timed captions are available for this clip."; return; }
    container.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:6px;max-height:180px;overflow:auto">' + data.words.map((w, i) => '<label><span class="help">' + w.start.toFixed(1) + 's</span><input class="caption-word" aria-label="Word ' + (i + 1) + '" value="' + esc(w.text) + '" style="width:100px;padding:5px"></label>').join('') + '</div>';
    button.disabled = false;
    button.onclick = async () => {
      button.disabled = true;
      try {
        const words = Array.from(container.querySelectorAll('.caption-word'), input => input.value.trim());
        await send(path, {words});
        toast('Caption changes saved. The clip is being re-rendered.', 'ok');
        $('#clipdlg').close(); await tick();
      } catch (error) { toast(error.message, 'bad'); button.disabled = false; }
    };
  } catch (error) { if (container?.isConnected) container.textContent = error.message; }
}
