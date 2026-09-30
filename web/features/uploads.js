// Attach: send a photo or file to the host and type its path into the
// terminal, where an agent can read it ("look at /path/to/photo.png").
export function wireUploads({ send, onStatus }) {
  const input = document.getElementById('attach-input');
  document.querySelector('[data-action="attach"]').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = ''; // the same files can be picked again
    await attachAll(files, { send, onStatus });
  });
  wireDrop({ send, onStatus });
  wireRecorder(document.querySelector('[data-action="record"]'), { send, onStatus });
}

// One at a time, so the paths reach the prompt in the order they were chosen.
async function attachAll(files, deps) {
  for (const file of files) await attach(file, file.name, deps);
}

// Files dragged from the desktop and dropped anywhere on the page attach like
// the picker. Only drags that carry files count: text dragged inside the page
// keeps its normal behaviour. The counter survives dragenter/dragleave firing
// on every child the pointer crosses.
function wireDrop(deps) {
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
  const showing = (on) => document.body.classList.toggle('dropping', on);
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    showing(true);
  });
  document.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --depth <= 0) (depth = 0), showing(false);
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // without it the browser opens the file instead of dropping
    e.dataTransfer.dropEffect = 'copy';
    showing(true);
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    showing(false);
    attachAll([...e.dataTransfer.files], deps);
  });
}

// upload saves the file on the host and returns its path, or null on failure.
async function upload(blob, name, { onStatus }) {
  onStatus(`Uploading ${name}…`);
  try {
    const res = await fetch(`/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
    if (!res.ok) throw new Error((await res.text()).trim() || res.statusText);
    return (await res.json()).path;
  } catch (e) {
    onStatus(`Upload failed: ${e.message}`);
    return null;
  }
}

// Paths are built by the host from safe characters only, so no quoting is needed.
async function attach(blob, name, deps) {
  const path = await upload(blob, name, deps);
  if (!path) return;
  deps.send(`${path} `);
  deps.onStatus('');
}

// Voice notes: tap to record, tap again to stop and upload, like an attachment.
// The path is typed at the prompt; what reads the audio is up to the harness.
// MediaRecorder picks the container the browser supports (WebM on Chrome and
// Android, MP4 on Safari); the file name carries the matching extension.
function wireRecorder(button, deps) {
  let recorder = null;
  let why = ''; // set when the phone, not the user, ended the note
  let started = 0;
  const setRecording = (on) => button.setAttribute('aria-pressed', String(on));
  const cut = (reason) => {
    if (!recorder) return;
    why ||= reason;
    if (recorder.state === 'recording') recorder.stop();
  };
  // Locked by hand or switched away: the phone cuts the mic, so send what was said.
  document.addEventListener('visibilitychange', () => document.hidden && cut('the app left the screen'));

  button.addEventListener('click', async () => {
    if (recorder) return recorder.stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      deps.onStatus(e.name === 'NotAllowedError' ? 'Allow the microphone to record' : `No microphone: ${e.message}`);
      return;
    }
    const chunks = [];
    const screen = keepScreenOn();
    why = '';
    started = Date.now();
    recorder = new MediaRecorder(stream);
    // A Home Screen app can get a mic iOS kills at once: on 2026-09-30 six notes
    // in a row came out empty and their paths were typed at the prompt anyway.
    stream.getAudioTracks().forEach((t) => (t.onended = () => cut('iOS cut the microphone')));
    recorder.onerror = () => cut('the recorder failed');
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      screen.then((lock) => lock?.release());
      stream.getTracks().forEach((t) => t.stop()); // release the mic (and its indicator) at once
      const type = recorder.mimeType || 'audio/webm';
      recorder = null;
      setRecording(false);
      const blob = new Blob(chunks, { type });
      if (!blob.size || (why && Date.now() - started < 500)) return deps.onStatus(nothingRecorded(why));
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      attach(blob, `voice-${stamp}.${ext}`, deps);
    };
    recorder.start();
    setRecording(true);
    deps.onStatus('Recording… tap the mic again to send');
  });
}

// iOS keeps a dead mic until the app is closed, and sometimes until a restart.
function nothingRecorded(why) {
  return `Nothing recorded (${why || 'the microphone gave no sound'}). Close the app and open it again; if it keeps happening, restart the phone.`;
}

// A phone that dimmed and locked mid-note cut the mic and lost the note.
// Wake Lock: iOS 16.4+, and 18.4+ as a Home Screen app.
async function keepScreenOn() {
  try {
    return await navigator.wakeLock?.request('screen');
  } catch {
    return null; // refused (Low Power Mode, low battery): record anyway
  }
}
