// Fills the "Who is behind it" block of the About page from config.js (BS.about). Nothing is shown until a name is filled in.
const A = (window.BS || {}).about || {};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const box = document.getElementById('founder');
if (box && A.name) {
  const paragraphs = String(A.story || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const photo = A.photo ? `<img class="ph" src="/${esc(String(A.photo).replace(/^\/+/, ''))}" alt="Photo of ${esc(A.name)}" width="200" height="200">` : '';
  const linkedin = /^https?:\/\//i.test(A.linkedin || '') ? `<p><a class="btn" href="${esc(A.linkedin)}" target="_blank" rel="noopener noreferrer">Connect on LinkedIn</a></p>` : '';
  box.innerHTML = `${photo}<div><h2 class="serif">${esc(A.name)}</h2><p class="role">${esc(A.role || '')}</p>${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('')}${linkedin}</div>`;
  box.classList.toggle('nophoto', !photo);
  box.hidden = false;
  document.getElementById('nofounder')?.setAttribute('hidden', '');
}
