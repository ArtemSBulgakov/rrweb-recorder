import '../ui.css';
import { strToU8, zipSync } from 'fflate';
import { deleteRecording, getEvents, listRecordings, renameRecording } from '../storage/db';
const ext = chrome;
const list = document.querySelector<HTMLElement>('#list')!;
document.querySelector('#import-recording')!.addEventListener('click', () => {
  location.href = ext.runtime.getURL('src/player/index.html?import=1');
});

async function render(): Promise<void> {
  const recordings = await listRecordings();
  list.replaceChildren();
  if (!recordings.length) {
    list.innerHTML = '<div class="card muted">No recordings yet.</div>';
    return;
  }
  for (const recording of recordings) {
    const card = document.createElement('article');
    card.className = 'card row';
    const duration = (recording.endedAt ?? Date.now()) - recording.startedAt;
    card.innerHTML = `<div><h2>${escapeHtml(recording.title)}</h2><div class="muted">${new Date(recording.startedAt).toLocaleString()} · ${Math.round(duration / 1000)}s · ${recording.tabs.length} tabs · ${recording.eventCount} events</div></div>`;
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    const play = document.createElement('button');
    const rename = document.createElement('button');
    rename.textContent = 'Rename';
    rename.className = 'secondary';
    rename.onclick = async () => {
      const title = prompt('Recording name', recording.title);
      if (title !== null) { await renameRecording(recording.id, title); await render(); }
    };
    const exportButton = document.createElement('button');
    exportButton.textContent = 'Export ZIP';
    exportButton.className = 'secondary';
    exportButton.onclick = async () => {
      const events = await getEvents(recording.id);
      const filename = recording.title.replace(/[^\w.-]+/g, '_') || 'recording';
      const archive = zipSync({
        [`${filename}.rrweb.json`]: strToU8(JSON.stringify({ recording, events }, null, 2)),
      }, { level: 9 });
      const blob = new Blob([
        archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer,
      ], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${filename}.rrweb.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    };
    play.textContent = 'Play';
    play.onclick = () => location.href = ext.runtime.getURL(`src/player/index.html?id=${encodeURIComponent(recording.id)}`);
    const remove = document.createElement('button');
    remove.textContent = 'Delete';
    remove.className = 'danger';
    remove.onclick = async () => { await deleteRecording(recording.id); await render(); };
    actions.append(play, rename, exportButton, remove);
    card.append(actions);
    list.append(card);
  }
}

function escapeHtml(value: string): string {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

void render();
