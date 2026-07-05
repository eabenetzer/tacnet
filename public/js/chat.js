/* ═══════════════════════════════════════════════════════════════
   Chat Module — Real-time text messaging
   ═══════════════════════════════════════════════════════════════ */
window.Chat = (function () {
  let socket = null;
  const messagesEl = document.getElementById('chat-messages');
  const inputEl = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  const badgeEl = document.getElementById('chat-badge');

  let unread = 0;
  let panelVisible = false;

  function init(sock) {
    socket = sock;

    socket.on('chat-message', (msg) => {
      appendMessage(msg);
      if (!panelVisible) {
        unread++;
        updateBadge();
      }
    });

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    socket.emit('chat-message', { text });
    inputEl.value = '';
    inputEl.focus();
  }

  function appendMessage(msg) {
    const isSystem = msg.from === 'SYSTEM';
    const div = document.createElement('div');
    div.className = 'chat-msg' + (isSystem ? ' system' : '');

    const timeStr = new Date(msg.time).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit'
    });

    if (isSystem) {
      div.innerHTML = `<div class="chat-msg-text">${escHtml(msg.text)}</div>`;
    } else {
      div.innerHTML = `
        <div class="chat-msg-header">
          <span class="chat-msg-name" style="color:${msg.color}">${escHtml(msg.from)}</span>
          <span class="chat-msg-time">${timeStr}</span>
        </div>
        <div class="chat-msg-text">${escHtml(msg.text)}</div>
      `;
    }

    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setPanelVisible(visible) {
    panelVisible = visible;
    if (visible) {
      unread = 0;
      updateBadge();
      // Scroll to bottom when opening
      setTimeout(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
        inputEl.focus();
      }, 100);
    }
  }

  function updateBadge() {
    if (unread > 0) {
      badgeEl.textContent = unread > 99 ? '99+' : unread;
      badgeEl.classList.remove('hidden');
    } else {
      badgeEl.classList.add('hidden');
    }
  }

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  return { init, setPanelVisible };
})();
