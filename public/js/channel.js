const API_URL = 'http://localhost:8000';
const LOGIN_URL = 'http://localhost:5173/login';

function redirectToLogin() {
    var currentUrl = window.location.href;
    var loginUrl = LOGIN_URL + '?redirect=' + encodeURIComponent(currentUrl);
    window.location.href = loginUrl;
}
var unreadChannelCounts = {};
var fileUrlCache = {};

async function getFileUrl(fileId) {
    if (fileUrlCache[fileId]) return fileUrlCache[fileId];
    try {
        const data = await apiCall(`/channels/files/${fileId}`);
        fileUrlCache[fileId] = data.url;
        return data.url;
    } catch (err) {
        console.error('Failed to get file URL:', err);
        return null;
    }
}


function getToken() {
    var urlParams = new URLSearchParams(window.location.search);
    var urlToken = urlParams.get('token');

    // Nếu URL có token => luôn cập nhật token mới
    if (urlToken) {
        localStorage.setItem('token', urlToken);

        urlParams.delete('token');

        const newQuery = urlParams.toString();
        const newUrl =
            window.location.pathname +
            (newQuery ? '?' + newQuery : '');

        window.history.replaceState({}, document.title, newUrl);

        return urlToken;
    }

    // fallback localStorage
    var localToken = localStorage.getItem('token');

    if (!localToken) {
        redirectToLogin();
        return null;
    }

    return localToken;
}

function showToast(message, type) {
    type = type || 'info';
    var container = document.getElementById('toast-container');
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () { toast.classList.add('show'); }, 10);
    setTimeout(function () {
        toast.classList.remove('show');
        setTimeout(function () { toast.remove(); }, 300);
    }, 3000);
}

// ====== Helper mới ======
function normalizeEmail(email) {
    return (email || '').toString().trim().toLowerCase();
}

function closeDocumentAIPanelOnly() {
    const panel = document.getElementById('document-ai-panel');
    const split = document.getElementById('chatroom-main-split');

    if (panel) panel.style.display = 'none';
    if (split) split.classList.remove('document-ai-open');

    currentAIConversation = null;
    currentDocumentAI = {
        file_id: null,
        message_id: null,
        file_name: null
    };

    documentAIMode = 'closed';
}

function disableChatInputForMute(reason, mutedUntil) {
    currentMuteState = {
        muted: true,
        channel_id: currentChannel ? currentChannel.channel_id : null,
        reason: reason || 'Bạn đang bị cấm gửi tin nhắn trong kênh này',
        muted_until: mutedUntil || null
    };

    syncMuteControls();
    scheduleMuteUnlock(mutedUntil);
}

function enableChatInputIfNotMuted() {
    clearMuteUnlockTimer();

    currentMuteState = {
        muted: false,
        channel_id: null,
        reason: null,
        muted_until: null
    };

    syncMuteControls();
}

function isMutedInCurrentChannel() {
    if (
        !currentMuteState ||
        !currentMuteState.muted ||
        !currentChannel ||
        String(currentMuteState.channel_id) !== String(currentChannel.channel_id)
    ) {
        return false;
    }

    if (currentMuteState.muted_until) {
        const unlockTime = new Date(currentMuteState.muted_until).getTime();

        if (unlockTime && !Number.isNaN(unlockTime) && Date.now() >= unlockTime) {
            handleMuteExpired();
            return false;
        }
    }

    return true;
}

function showMutedToast() {
    if (currentMuteState?.muted_until) {
        showToast(
            `Bạn đang bị cấm gửi tin nhắn đến ${formatMuteTime(currentMuteState.muted_until)}`,
            'warning'
        );
    } else {
        showToast(
            currentMuteState?.reason || 'Bạn đang bị cấm gửi tin nhắn trong kênh này',
            'warning'
        );
    }
}

function clearMuteUnlockTimer() {
    if (muteUnlockTimer) {
        clearTimeout(muteUnlockTimer);
        muteUnlockTimer = null;
    }
}

function scheduleMuteUnlock(mutedUntil) {
    clearMuteUnlockTimer();

    if (!mutedUntil) return;

    const unlockTime = new Date(mutedUntil).getTime();
    const now = Date.now();

    if (!unlockTime || Number.isNaN(unlockTime)) return;

    const delay = unlockTime - now;

    if (delay <= 0) {
        handleMuteExpired();
        return;
    }

    muteUnlockTimer = setTimeout(() => {
        handleMuteExpired();
    }, delay + 500);
}

async function handleMuteExpired() {
    clearMuteUnlockTimer();

    if (!currentChannel) {
        enableChatInputIfNotMuted();
        return;
    }

    try {
        const data = await apiCall(`/channels/${currentChannel.channel_id}/mute-status`);

        if (data.muted) {
            currentMuteState = {
                muted: true,
                channel_id: currentChannel.channel_id,
                reason: data.reason || 'Bạn đang bị cấm gửi tin nhắn trong kênh này',
                muted_until: data.muted_until || null
            };

            syncMuteControls();
            scheduleMuteUnlock(data.muted_until);
            return;
        }

        enableChatInputIfNotMuted();
        showToast('Bạn đã có thể gửi tin nhắn lại', 'success');
    } catch (err) {
        console.error('Check mute expired error:', err);

        // Nếu lỗi API thì vẫn thử mở UI theo thời gian local,
        // backend vẫn là lớp chặn cuối nếu thật sự chưa hết hạn.
        enableChatInputIfNotMuted();
    }
}

function handleCurrentUserKicked(channelId, message) {
    const kickedChannelId = channelId || (currentChannel ? currentChannel.channel_id : '');
    const toastKey = `kicked_${kickedChannelId}`;

    if (!shownKickToasts.has(toastKey)) {
        shownKickToasts.add(toastKey);

        showToast(
            message || 'Bạn đã bị xóa khỏi kênh này',
            'error'
        );

        setTimeout(() => {
            shownKickToasts.delete(toastKey);
        }, 5000);
    }

    if (
        currentChannel &&
        kickedChannelId &&
        String(currentChannel.channel_id) === String(kickedChannelId)
    ) {
        currentChannel = null;
        currentChatroom = null;
        messageList = [];
        memberList = [];

        if (channelSocket) {
            channelSocket.close();
            channelSocket = null;
        }

        document.getElementById('channel-empty').style.display = 'flex';
        document.getElementById('channel-detail').style.display = 'none';
    }

    loadChannels();
}

function syncMuteControls() {
    const muted = isMutedInCurrentChannel();

    const input = document.getElementById('chat-message-input');
    const sendBtn = document.getElementById('btn-send-message');
    const attachBtn = document.getElementById('btn-attach-file');
    const fileInput = document.getElementById('file-input');

    if (muted) {
        const reason = currentMuteState?.reason || 'Bạn đang bị cấm gửi tin nhắn trong kênh này';
        const mutedUntil = currentMuteState?.muted_until;

        if (input) {
            input.disabled = true;
            input.readOnly = true;
            input.value = '';

            if (mutedUntil) {
                input.placeholder = `Bạn đang bị cấm gửi tin nhắn đến ${formatMuteTime(mutedUntil)}`;
            } else {
                input.placeholder = reason;
            }
        }

        if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.classList.add('disabled');
            sendBtn.title = 'Bạn đang bị cấm gửi tin nhắn trong kênh này';
            sendBtn.style.pointerEvents = 'none';
            sendBtn.style.opacity = '0.5';
        }

        if (attachBtn) {
            attachBtn.disabled = true;
            attachBtn.classList.add('disabled');
            attachBtn.title = 'Bạn đang bị cấm gửi file trong kênh này';
            attachBtn.style.pointerEvents = 'none';
            attachBtn.style.opacity = '0.5';
        }

        if (fileInput) {
            fileInput.disabled = true;
            fileInput.value = '';
        }

        return;
    }

    if (input) {
        input.disabled = false;
        input.readOnly = false;
        input.placeholder = 'Nhập tin nhắn...';
    }

    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.classList.remove('disabled');
        sendBtn.title = '';
        sendBtn.style.pointerEvents = '';
        sendBtn.style.opacity = '';
    }

    if (attachBtn) {
        attachBtn.disabled = false;
        attachBtn.classList.remove('disabled');
        attachBtn.title = '';
        attachBtn.style.pointerEvents = '';
        attachBtn.style.opacity = '';
    }

    if (fileInput) {
        fileInput.disabled = false;
        fileInput.value = '';
    }
}

function formatMuteTime(value) {
    try {
        const d = new Date(value);
        return d.toLocaleString('vi-VN');
    } catch (e) {
        return '';
    }
}

function isCurrentUserEmail(email) {
    return normalizeEmail(email) === normalizeEmail(getCurrentUserEmail());
}

function extractErrorMessage(errorData, fallbackMessage) {
    fallbackMessage = fallbackMessage || 'Có lỗi xảy ra';

    if (!errorData) return fallbackMessage;

    if (typeof errorData === 'string') {
        return errorData;
    }

    if (typeof errorData.detail === 'string') {
        return errorData.detail;
    }

    if (errorData.detail && typeof errorData.detail === 'object') {
        if (errorData.detail.reason) return errorData.detail.reason;
        if (errorData.detail.error) return errorData.detail.error;
        if (errorData.detail.message) return errorData.detail.message;
    }

    if (errorData.reason) return errorData.reason;
    if (errorData.error) return errorData.error;
    if (errorData.message) return errorData.message;

    return fallbackMessage;
}

function showUploadErrorByStatus(status, message) {
    if (status === 503) {
        showToast(
            message || 'AI kiểm duyệt đang không khả dụng, vui lòng thử lại sau',
            'warning'
        );
        return;
    }

    if (status === 400) {
        showToast(
            message || 'File không được phép upload do vi phạm quy tắc kiểm duyệt',
            'error'
        );
        return;
    }

    showToast(message || 'Upload thất bại', 'error');
}

function moderationActionLabel(action) {
    switch (action) {
        case 'warn':
            return 'cảnh báo';
        case 'mute':
            return 'cấm gửi tin nhắn';
        case 'kick':
            return 'mời khỏi kênh';
        case 'ban':
            return 'cấm khỏi kênh';
        default:
            return action || 'xử lý';
    }
}

async function apiCall(endpoint, method, body) {
    method = method || 'GET';
    var token = getToken();
    if (!token) return Promise.reject('No token');
    var options = {
        method: method,
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        }
    };
    if (body) options.body = JSON.stringify(body);

    try {
        const res = await fetch(API_URL + endpoint, options);
        if (res.status === 401) {
            localStorage.removeItem('token');
            redirectToLogin();
            throw new Error('Unauthorized');
        }
        if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            const errorMsg = extractErrorMessage(errorData, `HTTP ${res.status}`);
            const error = new Error(errorMsg);
            error.status = res.status;
            error.data = errorData;
            throw error;
        }
        return await res.json();
    } catch (err) {
        console.error(`API Error ${endpoint}:`, err);
        throw err;
    }
}

// ====== State ======
var currentChannel = null;
var currentChatroom = null;
var channelList = [];
var chatroomList = [];
var memberList = [];
var messageList = [];
var shownRemovedMessageToasts = new Set();
var shownKickToasts = new Set();
var currentOnlineUsers = [];
var currentMuteState = {
    muted: false,
    channel_id: null,
    reason: null,
    muted_until: null
};
var currentDocumentAI = {
    file_id: null,
    message_id: null,
    file_name: null
};
var muteUnlockTimer = null;
var messagePollingTimer = null;
var memberPollingTimer = null;
let channelPollingTimer = null;
let chatroomPollingTimer = null;

var currentAIConversation = null;
var aiConversationList = [];
var documentAIMode = 'closed';

var avatarCache = {};
async function getUserAvatar(email) {
    if (avatarCache[email]) return avatarCache[email];
    try {
        const data = await apiCall(`/account/account_info?email=${email}`);
        const avatar = data.avatar || null;
        avatarCache[email] = avatar;
        return avatar;
    } catch (err) {
        console.error(`Failed to get avatar for ${email}:`, err);
        return null;
    }
}

let channelAvatarCache = {};
async function getChannelAvatarUrl(fileId) {
    if (!fileId) return null;
    if (channelAvatarCache[fileId]) return channelAvatarCache[fileId];
    try {
        const data = await apiCall(`/channels/files/${fileId}`);
        channelAvatarCache[fileId] = data.url;
        return data.url;
    } catch (err) {
        console.error('Failed to get channel avatar URL:', err);
        return null;
    }
}

// Avatar update UI functions
async function updateChannelAvatarInUI() {
    const avatarContainer = document.getElementById('channel-avatar');
    if (!avatarContainer) return;
    if (currentChannel && currentChannel.avatar) {
        let url = await getChannelAvatarUrl(currentChannel.avatar);
        if (url) {
            avatarContainer.innerHTML = `<img src="${url}" class="channel-avatar-img" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">`;
        } else {
            avatarContainer.innerHTML = '<i class="fas fa-hashtag"></i>';
        }
    } else {
        avatarContainer.innerHTML = '<i class="fas fa-hashtag"></i>';
    }
}
async function loadChannelAvatarPreview() {
    const img = document.getElementById('channel-avatar-preview');
    const placeholder = document.getElementById('channel-avatar-placeholder');
    if (!currentChannel || !currentChannel.avatar) {
        if (img) img.style.display = 'none';
        if (placeholder) placeholder.style.display = 'flex';
    } else {
        let url = await getChannelAvatarUrl(currentChannel.avatar);
        if (url && img) {
            img.src = url;
            img.style.display = 'block';
            placeholder.style.display = 'none';
        } else if (img) {
            img.style.display = 'none';
            if (placeholder) placeholder.style.display = 'flex';
        }
    }
}

// Avatar upload listeners
document.getElementById('btn-upload-avatar')?.addEventListener('click', () => {
    document.getElementById('avatar-file-input').click();
});
document.getElementById('avatar-file-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const token = getToken();
        const response = await fetch(`${API_URL}/channels/${currentChannel.channel_id}/avatar`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        if (!response.ok) throw new Error('Upload failed');
        const data = await response.json();
        currentChannel.avatar = data.file_id;
        if (data.file_id) {
            if (currentChannel.avatar && currentChannel.avatar !== data.file_id) {
                delete channelAvatarCache[currentChannel.avatar];
            }
            await loadChannelAvatarPreview();
            await updateChannelAvatarInUI();
            renderChannelList();
            showToast('Cập nhật ảnh đại diện thành công', 'success');
        }
    } catch (err) {
        showToast('Lỗi upload: ' + err.message, 'error');
    }
});
document.getElementById('btn-remove-avatar')?.addEventListener('click', async () => {
    if (!confirm('Bạn có chắc muốn xóa ảnh đại diện?')) return;
    try {
        const token = getToken();
        const response = await fetch(`${API_URL}/channels/${currentChannel.channel_id}/avatar`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error('Delete failed');
        if (currentChannel.avatar) delete channelAvatarCache[currentChannel.avatar];
        currentChannel.avatar = null;
        loadChannelAvatarPreview();
        updateChannelAvatarInUI();
        renderChannelList();
        showToast('Đã xóa ảnh đại diện', 'success');
    } catch (err) {
        showToast('Lỗi xóa ảnh: ' + err.message, 'error');
    }
});

var unreadCounts = {};
async function loadUnreadCounts(channelId) {
    try {
        const data = await apiCall(`/channels/${channelId}/unread-counts`);
        unreadCounts = data.unread_counts || {};
        renderChatroomList();
    } catch (err) {
        console.error('Failed to load unread counts:', err);
    }
}

function startChannelPolling() {
    // Đã bỏ polling /channels/my-channels.
    // Danh sách channel sẽ được load khi mở trang hoặc sau các thao tác create/join/delete.
}

function stopChannelPolling() {
    if (channelPollingTimer) {
        clearInterval(channelPollingTimer);
        channelPollingTimer = null;
    }
}

function startChatroomPolling() {
    // Đã bỏ polling /channels/{channel_id}/chatrooms.
    // Danh sách chatroom sẽ cập nhật qua WebSocket event chatroom_created/chatroom_deleted.
}

function stopChatroomPolling() {
    if (chatroomPollingTimer) {
        clearInterval(chatroomPollingTimer);
        chatroomPollingTimer = null;
    }
}

var token = getToken();
if (!token) throw new Error("Redirecting to login...");

// WebSocket
let channelSocket = null;
let presencePingTimer = null;
let userSocket = null;
let userPingTimer = null;

function startUserPing() {
    stopUserPing();

    userPingTimer = setInterval(() => {
        if (userSocket && userSocket.readyState === WebSocket.OPEN) {
            userSocket.send(JSON.stringify({ type: 'ping' }));
        }
    }, 20000);
}

function stopUserPing() {
    if (userPingTimer) {
        clearInterval(userPingTimer);
        userPingTimer = null;
    }
}

function startPresencePing() {
    stopPresencePing();

    presencePingTimer = setInterval(() => {
        if (channelSocket && channelSocket.readyState === WebSocket.OPEN) {
            channelSocket.send(JSON.stringify({ type: 'ping' }));
        }
    }, 20000);
}

function stopPresencePing() {
    if (presencePingTimer) {
        clearInterval(presencePingTimer);
        presencePingTimer = null;
    }
}

function upsertChannelInList(channel) {
    if (!channel || !channel.channel_id) return;

    const existed = channelList.some(
        ch => String(ch.channel_id) === String(channel.channel_id)
    );

    if (existed) {
        channelList = channelList.map(ch =>
            String(ch.channel_id) === String(channel.channel_id)
                ? { ...ch, ...channel }
                : ch
        );
    } else {
        channelList.push(channel);
    }

    renderChannelList();
}

function removeChannelFromList(channelId) {
    if (!channelId) return;

    channelList = channelList.filter(
        ch => String(ch.channel_id) !== String(channelId)
    );

    renderChannelList();
}

function resetCurrentChannelUI() {
    clearMuteUnlockTimer();
    enableChatInputIfNotMuted();

    currentChannel = null;
    currentChatroom = null;
    chatroomList = [];
    memberList = [];
    messageList = [];
    currentOnlineUsers = [];

    stopPresencePing();
    stopMessagePolling();
    stopMemberPolling();
    stopChatroomPolling();

    if (channelSocket) {
        channelSocket.close();
        channelSocket = null;
    }

    const emptyEl = document.getElementById('channel-empty');
    const detailEl = document.getElementById('channel-detail');
    const chatroomEmptyInner = document.getElementById('chatroom-empty-inner');
    const chatroomActive = document.getElementById('chatroom-active');
    const messagesContainer = document.getElementById('chatroom-messages');

    if (emptyEl) emptyEl.style.display = 'flex';
    if (detailEl) detailEl.style.display = 'none';
    if (chatroomEmptyInner) chatroomEmptyInner.style.display = 'flex';
    if (chatroomActive) chatroomActive.style.display = 'none';
    if (messagesContainer) messagesContainer.innerHTML = '';

    renderChatroomList();
    renderMembers();
}

function connectUserWebsocket() {
    if (userSocket) {
        stopUserPing();
        userSocket.close();
        userSocket = null;
    }

    const token = getToken();
    if (!token) return;

    const wsUrl = `ws://localhost:8000/channels/ws-user?token=${token}`;
    userSocket = new WebSocket(wsUrl);

    userSocket.onopen = () => {
        console.log('User WebSocket connected');

        if (userSocket && userSocket.readyState === WebSocket.OPEN) {
            userSocket.send(JSON.stringify({ type: 'ping' }));
            startUserPing();
        }
    };

    userSocket.onmessage = async function (event) {
        console.log('[USER_WS] Received:', event.data);

        try {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'pong':
                    break;

                case 'channel_updated': {
                    console.log('[USER_WS] channel_updated:', data);

                    const updatedChannel = data.channel || data;
                    const channelId = data.channel_id || updatedChannel?.channel_id;

                    if (!channelId) {
                        console.warn('[USER_WS] channel_updated missing channel_id:', data);
                        break;
                    }

                    if (updatedChannel && updatedChannel.channel_id) {
                        upsertChannelInList({
                            ...updatedChannel,
                            channel_id: channelId
                        });
                    }

                    // Đồng bộ sidebar đúng 1 lần khi có event, không phải polling
                    await loadChannels();

                    if (
                        currentChannel &&
                        String(currentChannel.channel_id) === String(channelId)
                    ) {
                        currentChannel = {
                            ...currentChannel,
                            ...updatedChannel
                        };

                        await renderChannelDetail();
                    }

                    break;
                }

                case 'channel_deleted': {
                    console.log('[USER_WS] channel_deleted:', data);

                    const deletedChannelId = data.channel_id;

                    if (!deletedChannelId) {
                        console.warn('[USER_WS] channel_deleted missing channel_id:', data);
                        break;
                    }

                    // Xóa ngay khỏi state sidebar trước
                    removeChannelFromList(deletedChannelId);

                    if (
                        currentChannel &&
                        String(currentChannel.channel_id) === String(deletedChannelId)
                    ) {
                        resetCurrentChannelUI();
                        showToast('Kênh này đã bị xóa', 'warning');
                    }

                    // Đồng bộ sidebar đúng 1 lần sau khi xóa, không phải polling
                    await loadChannels();

                    break;
                }

                case 'you_were_kicked': {
                    console.log('[USER_WS] you_were_kicked:', data);

                    const kickedChannelId = data.channel_id;

                    if (!kickedChannelId) {
                        console.warn('[USER_WS] you_were_kicked missing channel_id:', data);
                        break;
                    }

                    removeChannelFromList(kickedChannelId);

                    handleCurrentUserKicked(
                        kickedChannelId,
                        data.reason || 'Bạn đã bị xóa khỏi kênh này'
                    );

                    break;
                }

                case 'pending_member_request': {
                    const member = data.member;

                    if (
                        currentChannel &&
                        String(currentChannel.channel_id) === String(data.channel_id)
                    ) {
                        if (member && member.email) {
                            const existed = memberList.some(
                                m => normalizeEmail(m.email) === normalizeEmail(member.email)
                            );

                            if (!existed) {
                                memberList.push({
                                    ...member,
                                    status: 'pending',
                                    is_online: false
                                });
                            } else {
                                memberList = memberList.map(m =>
                                    normalizeEmail(m.email) === normalizeEmail(member.email)
                                        ? { ...m, ...member, status: 'pending' }
                                        : m
                                );
                            }

                            renderMembers();
                        }
                    }

                    showToast('Có yêu cầu tham gia kênh mới', 'info');

                    break;
                }

                case 'pending_member_resolved': {
                    if (
                        currentChannel &&
                        String(currentChannel.channel_id) === String(data.channel_id)
                    ) {
                        memberList = memberList.filter(
                            m => normalizeEmail(m.email) !== normalizeEmail(data.member_email)
                        );

                        await loadMembers(currentChannel.channel_id);
                    }

                    break;
                }

                case 'join_request_approved': {
                    console.log('[USER_WS] join_request_approved:', data);

                    if (data.channel) {
                        upsertChannelInList(data.channel);
                    }

                    // Fallback đồng bộ sidebar đúng 1 lần
                    await loadChannels();

                    showToast('Yêu cầu tham gia kênh của bạn đã được chấp nhận', 'success');

                    break;
                }

                case 'join_request_rejected': {
                    console.log('[USER_WS] join_request_rejected:', data);

                    showToast('Yêu cầu tham gia kênh của bạn đã bị từ chối', 'warning');

                    break;
                }

                case 'channel_joined': {
                    console.log('[USER_WS] channel_joined:', data);

                    if (data.channel) {
                        upsertChannelInList(data.channel);
                    }

                    await loadChannels();

                    break;
                }

                case 'member_joined': {
                    console.log('[USER_WS] member_joined:', data);

                    if (
                        currentChannel &&
                        String(currentChannel.channel_id) === String(data.channel_id)
                    ) {
                        await loadMembers(currentChannel.channel_id);
                    }

                    break;
                }

                default:
                    console.log('[USER_WS] Unknown event:', data.type);
            }
        } catch (err) {
            console.error('User WebSocket message error:', err);
        }
    };

    userSocket.onerror = (error) => {
        console.error('User WebSocket error:', error);
    };

    userSocket.onclose = (event) => {
        console.log('❌ User WebSocket closed:', event.code, event.reason);
        stopUserPing();
        userSocket = null;
    };
}

function connectChannelWebsocket(channelId) {
    if (channelSocket) { stopPresencePing(); channelSocket.close(); channelSocket = null; }
    const token = getToken();
    if (!token) return;
    const wsUrl = `ws://localhost:8000/channels/ws/${channelId}?token=${token}`;
    channelSocket = new WebSocket(wsUrl);
    channelSocket.onopen = () => {
        console.log('Channel WebSocket connected');

        if (channelSocket && channelSocket.readyState === WebSocket.OPEN) {
            channelSocket.send(JSON.stringify({ type: 'ping' }));
            startPresencePing();
        }
    };
    channelSocket.onmessage = async function (event) {
        console.log('[WS] Received:', event.data);
        try {
            const data = JSON.parse(event.data);
            switch (data.type) {
                case 'presence_snapshot':
                    applyOnlineSnapshot(data.online_users || []);
                    break;

                case 'presence_update':
                    if (data.action === 'online') {
                        setMemberOnline(data.user);
                    } else if (data.action === 'offline') {
                        setMemberOffline(data.user_email);
                    }
                    break;

                case 'pong':
                    break;

                case 'new_message':
                    if (data.message.sender_email !== getCurrentUserEmail()) {
                        const msgRoomId = data.message.room_id;
                        if (!currentChatroom || currentChatroom.room_id !== msgRoomId) {
                            unreadCounts[msgRoomId] = (unreadCounts[msgRoomId] || 0) + 1;
                            renderChatroomList();
                        }
                        if (currentChatroom && data.message.room_id === currentChatroom.room_id) {
                            if (!messageList.some(m => m.message_id === data.message.message_id)) {
                                messageList.push(data.message);
                                await appendNewMessages([data.message]);
                            }
                        }
                    }
                    break;
                case 'channel_updated': {
                    console.log('[USER_WS] channel_updated:', data);

                    const updatedChannel = data.channel || data;
                    const channelId = data.channel_id || updatedChannel?.channel_id;

                    if (!channelId) {
                        console.warn('[USER_WS] channel_updated missing channel_id:', data);
                        break;
                    }

                    if (updatedChannel && updatedChannel.channel_id) {
                        upsertChannelInList({
                            ...updatedChannel,
                            channel_id: channelId
                        });
                    }

                    // Fallback đồng bộ sidebar đúng 1 lần, không phải polling
                    await loadChannels();

                    if (currentChannel && String(currentChannel.channel_id) === String(channelId)) {
                        currentChannel = {
                            ...currentChannel,
                            ...updatedChannel
                        };

                        await renderChannelDetail();
                    }

                    break;
                }
                case 'channel_deleted': {
                    console.log('[USER_WS] channel_deleted:', data);

                    const deletedChannelId = data.channel_id;

                    if (!deletedChannelId) {
                        console.warn('[USER_WS] channel_deleted missing channel_id:', data);
                        break;
                    }

                    removeChannelFromList(deletedChannelId);

                    // Fallback đồng bộ sidebar đúng 1 lần, không phải polling
                    await loadChannels();

                    if (currentChannel && String(currentChannel.channel_id) === String(deletedChannelId)) {
                        resetCurrentChannelUI();
                        showToast('Kênh này đã bị xóa', 'warning');
                    }

                    break;
                }
                case 'chatroom_created': {
                    console.log('[WS] chatroom_created:', data);

                    const newRoom = data.chatroom || data.room || data;

                    if (!newRoom || !newRoom.room_id) {
                        console.warn('[WS] chatroom_created missing room data:', data);
                        break;
                    }

                    const eventChannelId =
                        data.channel_id ||
                        newRoom.channel_id ||
                        data.chatroom?.channel_id;

                    if (
                        currentChannel &&
                        eventChannelId &&
                        String(currentChannel.channel_id) !== String(eventChannelId)
                    ) {
                        console.warn('[WS] chatroom_created ignored because channel mismatch:', {
                            current: currentChannel.channel_id,
                            event: eventChannelId
                        });
                        break;
                    }

                    const existed = chatroomList.some(
                        r => String(r.room_id) === String(newRoom.room_id)
                    );

                    if (!existed) {
                        chatroomList.push(newRoom);
                    } else {
                        chatroomList = chatroomList.map(r =>
                            String(r.room_id) === String(newRoom.room_id) ? { ...r, ...newRoom } : r
                        );
                    }

                    renderChatroomList();

                    showToast(`Phòng "${newRoom.name || 'mới'}" đã được tạo`, 'success');

                    break;
                }
                case 'chatroom_updated': {
                    console.log('[WS] chatroom_updated:', data);

                    const updatedRoom = data.chatroom;
                    const eventChannelId = data.channel_id || updatedRoom?.channel_id;

                    if (!updatedRoom || !updatedRoom.room_id) {
                        console.warn('[WS] chatroom_updated missing room data:', data);
                        break;
                    }

                    if (
                        currentChannel &&
                        eventChannelId &&
                        String(currentChannel.channel_id) !== String(eventChannelId)
                    ) {
                        console.warn('[WS] chatroom_updated ignored because channel mismatch:', {
                            current: currentChannel.channel_id,
                            event: eventChannelId
                        });
                        break;
                    }

                    chatroomList = chatroomList.map(room => {
                        if (String(room.room_id) === String(updatedRoom.room_id)) {
                            return {
                                ...room,
                                ...updatedRoom
                            };
                        }

                        return room;
                    });

                    if (currentChatroom && String(currentChatroom.room_id) === String(updatedRoom.room_id)) {
                        currentChatroom = {
                            ...currentChatroom,
                            ...updatedRoom
                        };

                        const nameEl = document.getElementById('chatroom-name');
                        const descEl = document.getElementById('chatroom-desc');
                        const welcomeEl = document.getElementById('welcome-room-name');

                        if (nameEl) nameEl.textContent = currentChatroom.name || '';
                        if (descEl) descEl.textContent = currentChatroom.description || '';
                        if (welcomeEl) welcomeEl.textContent = currentChatroom.name || '';
                    }

                    renderChatroomList();

                    showToast(`Phòng "${updatedRoom.name || 'chat'}" đã được cập nhật`, 'success');

                    break;
                }
                case 'chatroom_deleted':
                    if (currentChannel) {
                        const index = chatroomList.findIndex(r => r.room_id === data.room_id);
                        if (index !== -1) {
                            chatroomList.splice(index, 1);
                            renderChatroomList();
                            if (currentChatroom && currentChatroom.room_id === data.room_id) {
                                currentChatroom = null;
                                document.getElementById('chatroom-empty-inner').style.display = 'flex';
                                document.getElementById('chatroom-active').style.display = 'none';
                            }
                            showToast('Phòng chat đã bị xóa', 'warning');
                        }
                    }
                    break;
                case 'member_approved':
                    const currentEmail = getCurrentUserEmail();
                    if (data.member.email === currentEmail) {
                        showToast('Bạn đã được chấp nhận tham gia kênh!', 'success');
                        loadChannels();
                    } else if (currentChannel && currentChannel.channel_id === data.member.channel_id) {
                        loadMembers(currentChannel.channel_id);
                    }
                    break;
                case 'member_kicked':
                    console.log('[WS] member_kicked:', data);

                    if (isCurrentUserEmail(data.member_email)) {
                        handleCurrentUserKicked(
                            data.channel_id,
                            data.reason || 'Bạn đã bị xóa khỏi kênh này'
                        );

                        break;
                    }

                    if (currentChannel && currentChannel.channel_id === data.channel_id) {
                        memberList = memberList.filter(m => normalizeEmail(m.email) !== normalizeEmail(data.member_email));
                        renderMembers();

                        const memberCountEl = document.getElementById('member-count');
                        if (memberCountEl) {
                            memberCountEl.innerHTML = '<i class="fas fa-users"></i> <span>' + memberList.length + '</span>';
                        }

                        showToast(`${data.member_email} đã bị xóa khỏi kênh`, 'warning');
                    }

                    break;
                case 'member_left': {
                    console.log('[WS] member_left:', data);

                    const leftEmail = data.member_email;
                    const eventChannelId = data.channel_id;

                    if (!leftEmail) {
                        console.warn('[WS] member_left missing member_email:', data);
                        break;
                    }

                    if (
                        currentChannel &&
                        eventChannelId &&
                        String(currentChannel.channel_id) !== String(eventChannelId)
                    ) {
                        break;
                    }

                    memberList = memberList.filter(
                        m => normalizeEmail(m.email) !== normalizeEmail(leftEmail)
                    );

                    renderMembers();

                    const memberCountEl = document.getElementById('member-count');
                    if (memberCountEl) {
                        memberCountEl.innerHTML =
                            '<i class="fas fa-users"></i> <span>' + memberList.length + '</span>';
                    }

                    // Chỉ thông báo cho user khác, không thông báo cho chính user vừa rời
                    if (!isCurrentUserEmail(leftEmail)) {
                        showToast(`${leftEmail} đã rời khỏi kênh`, 'info');
                    }

                    break;
                }
                case 'channel_avatar_updated':
                    if (currentChannel && currentChannel.channel_id === data.channel_id) {
                        const oldFileId = currentChannel.avatar;
                        currentChannel.avatar = data.file_id;
                        if (oldFileId && oldFileId !== data.file_id) delete channelAvatarCache[oldFileId];
                        if (data.file_id) delete channelAvatarCache[data.file_id];
                        updateChannelAvatarInUI();
                        loadChannelAvatarPreview();
                        renderChannelList();
                    }
                    break;
                case 'message_removed': {
                    console.log('[WS] message_removed:', data);

                    messageList = messageList.filter(m => m.message_id !== data.message_id);

                    if (currentChatroom && data.room_id === currentChatroom.room_id) {
                        const msgEl = document.querySelector(
                            `.message-item[data-message-id="${data.message_id}"]`
                        );

                        if (msgEl) {
                            msgEl.remove();
                        } else {
                            await renderMessages();
                        }
                    }

                    if (isCurrentUserEmail(data.user_email)) {
                        const toastKey = `${data.message_id || ''}_${data.reason || ''}`;

                        if (!shownRemovedMessageToasts.has(toastKey)) {
                            shownRemovedMessageToasts.add(toastKey);

                            showToast(
                                `⚠️ Nội dung của bạn đã bị gỡ: ${data.reason || 'Vi phạm quy tắc kiểm duyệt'}`,
                                'warning'
                            );

                            setTimeout(() => {
                                shownRemovedMessageToasts.delete(toastKey);
                            }, 8000);
                        }
                    }

                    break;
                }
                case 'user_warning':
                    console.log('[WS] user_warning:', data);

                    if (isCurrentUserEmail(data.user_email)) {
                        const remaining = Number(data.remaining ?? 0);
                        const reason = data.reason || 'Vi phạm quy tắc kiểm duyệt';

                        if (remaining > 0) {
                            showToast(
                                `⚠️ Cảnh báo: ${reason}. Bạn còn ${remaining} lần vi phạm trước khi bị ${moderationActionLabel(data.action)}.`,
                                'warning'
                            );
                        } else {
                            showToast(
                                `⚠️ Cảnh báo: ${reason}.`,
                                'warning'
                            );
                        }
                    }

                    break;
                case 'user_violation': {
                    console.log('[WS] user_violation:', data);

                    if (!isCurrentUserEmail(data.user_email)) {
                        break;
                    }

                    const actionLabel = moderationActionLabel(data.action);
                    const reason = data.reason || 'Vi phạm quy tắc kiểm duyệt';
                    const eventChannelId = data.channel_id;

                    showToast(
                        `❌ Bạn đã bị ${actionLabel}: ${reason}`,
                        'error'
                    );

                    if (data.action === 'kick' || data.action === 'ban') {
                        setTimeout(() => location.reload(), 1200);
                        break;
                    }

                    if (data.action === 'mute') {
                        // Chỉ khóa input nếu event mute thuộc đúng channel hiện tại
                        if (
                            currentChannel &&
                            eventChannelId &&
                            String(currentChannel.channel_id) === String(eventChannelId)
                        ) {
                            disableChatInputForMute(reason, data.muted_until);
                        }

                        break;
                    }

                    break;
                }
                default: console.log('Unknown event type:', data.type);
            }
        } catch (err) { console.error('WebSocket message error:', err); }
    };
    channelSocket.onerror = (error) => { console.error('WebSocket error:', error); };
    channelSocket.onclose = (event) => { console.log('❌ WebSocket closed:', event.code, event.reason); stopPresencePing(); channelSocket = null; };
}

document.getElementById('channel-loading').style.display = 'none';
document.getElementById('channel-app').style.display = 'flex';

function loadChannels() {
    return apiCall('/channels/my-channels').then(function (data) {
        channelList = data.channels || data || [];
        renderChannelList();
        return channelList;
    }).catch(function (err) {
        console.error('Load channels error:', err);
        showToast('Không thể tải danh sách kênh: ' + err.message, 'error');
        throw err;
    });
}

function renderChannelList() {
    var container = document.getElementById('channel-list');
    var searchTerm = document.getElementById('search-channel').value.toLowerCase();
    var filtered = channelList.filter(ch => ch.name.toLowerCase().indexOf(searchTerm) !== -1);
    var html = '';
    filtered.forEach(ch => {
        var isActive = currentChannel && currentChannel.channel_id === ch.channel_id ? ' active' : '';
        var avatarHtml = '<i class="fas fa-hashtag"></i>';
        if (ch.avatar) {
            var cachedUrl = channelAvatarCache[ch.avatar];
            if (cachedUrl) {
                avatarHtml = `<img src="${cachedUrl}" class="channel-avatar-img" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">`;
            } else {
                avatarHtml = '<i class="fas fa-spinner fa-spin"></i>';
                getChannelAvatarUrl(ch.avatar).then(url => {
                    if (url) { channelAvatarCache[ch.avatar] = url; renderChannelList(); }
                    else { channelAvatarCache[ch.avatar] = null; renderChannelList(); }
                });
            }
        }
        var unread = unreadChannelCounts[ch.channel_id] || 0;
        var unreadBadge = unread > 0 ? '<span class="unread-badge"></span>' : '';
        var channelNameClass = unread > 0 ? 'channel-item-name unread' : 'channel-item-name';
        html += `<div class="channel-item${isActive}" data-id="${ch.channel_id}" onclick="selectChannel('${ch.channel_id}')">
            <div class="channel-item-avatar">${avatarHtml}</div>
            <div class="channel-item-info">
                <div class="${channelNameClass}">${escapeHtml(ch.name)}${unreadBadge}</div>
                <div class="channel-item-desc">${escapeHtml(ch.description || '')}</div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

function escapeHtml(text) {
    if (!text) return '';
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function isDocumentFileName(fileName) {
    return isUTEZoneAISupportedFile(fileName);
}

const UTEZONE_AI_FILE_LIMITS_MB = {
    pdf: 12,
    docx: 10,
    xlsx: 5,
    xls: 5,
    csv: 3,
    txt: 2,
    md: 2,
    js: 1,
    jsx: 1,
    ts: 1,
    tsx: 1,
    py: 1,
    java: 1,
    c: 1,
    cpp: 1,
    h: 1,
    hpp: 1,
    cs: 1,
    php: 1,
    rb: 1,
    go: 1,
    rs: 1,
    html: 1,
    css: 1,
    json: 1,
    xml: 1,
    yml: 1,
    yaml: 1,
    sql: 1,
    sh: 1,
    bat: 1
};

var aiFileSizeCache = {};

function getFileExtension(fileName) {
    return (fileName || '').split('.').pop().toLowerCase();
}

function getUTEZoneAIFileSizeLimitBytes(fileName) {
    const ext = getFileExtension(fileName);
    const limitMb = UTEZONE_AI_FILE_LIMITS_MB[ext];

    if (!limitMb) return null;

    return limitMb * 1024 * 1024;
}

function formatFileSize(bytes) {
    if (!bytes || Number.isNaN(Number(bytes))) return '';

    const size = Number(bytes);

    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;

    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function isUTEZoneAISupportedFile(fileName) {
    const ext = getFileExtension(fileName);
    return Object.prototype.hasOwnProperty.call(UTEZONE_AI_FILE_LIMITS_MB, ext);
}

async function getRemoteFileSize(fileId) {
    if (!fileId) return null;

    if (aiFileSizeCache[fileId]) {
        return aiFileSizeCache[fileId];
    }

    try {
        const url = fileUrlCache[fileId] || await getFileUrl(fileId);

        if (!url) return null;

        const response = await fetch(url, {
            method: 'HEAD'
        });

        if (!response.ok) return null;

        const contentLength = response.headers.get('content-length');

        if (!contentLength) return null;

        const size = Number(contentLength);

        if (!size || Number.isNaN(size)) return null;

        aiFileSizeCache[fileId] = size;

        return size;

    } catch (err) {
        console.warn('[UTEZoneAI] Không lấy được dung lượng file:', err);
        return null;
    }
}

async function canAnalyzeFileWithUTEZoneAI(fileId, fileName, knownSize) {
    if (!isUTEZoneAISupportedFile(fileName)) {
        showToast('Định dạng file này chưa được UTEZoneAI hỗ trợ', 'warning');
        return false;
    }

    const maxBytes = getUTEZoneAIFileSizeLimitBytes(fileName);

    let fileSize = Number(knownSize || 0);

    if (!fileSize && aiFileSizeCache[fileId]) {
        fileSize = aiFileSizeCache[fileId];
    }

    if (!fileSize) {
        fileSize = await getRemoteFileSize(fileId);
    }

    if (fileSize && maxBytes && fileSize > maxBytes) {
        showToast('Dung lượng File quá lớn', 'error');
        return false;
    }

    return true;
}

function renderFileMessageContent(msg, fileUrl) {
    const fileName = msg.file_name || 'Tải file';
    const fileId = msg.content;
    const messageId = msg.message_id || '';
    const fileSize = Number(msg.file_size || aiFileSizeCache[fileId] || 0);
    const ext = getFileExtension(fileName);

    let icon = '<i class="fas fa-paperclip"></i>';

    if (['pdf'].includes(ext)) {
        icon = '<i class="fas fa-file-pdf"></i>';
    } else if (['doc', 'docx'].includes(ext)) {
        icon = '<i class="fas fa-file-word"></i>';
    } else if (['txt', 'md'].includes(ext)) {
        icon = '<i class="fas fa-file-alt"></i>';
    } else if (['xls', 'xlsx', 'csv'].includes(ext)) {
        icon = '<i class="fas fa-file-excel"></i>';
    } else if (['zip', 'rar', '7z'].includes(ext)) {
        icon = '<i class="fas fa-file-archive"></i>';
    }

    const safeFileName = escapeHtml(fileName);

    const askBtn = isDocumentFileName(fileName)
        ? `
            <button
                type="button"
                class="ask-document-ai-btn"
                onclick="event.preventDefault(); event.stopPropagation(); openDocumentAI('${String(fileId).replace(/'/g, "\\'")}', '${String(messageId).replace(/'/g, "\\'")}', '${String(fileName).replace(/'/g, "\\'")}', ${fileSize || 0})">
                <i class="fas fa-robot"></i> Hỏi UTEZoneAI
            </button>
        `
        : '';

    return `
        <span class="message-file-wrapper">
            <a href="${fileUrl}" target="_blank" style="color:#323cae; text-decoration:none;">
                ${icon} ${safeFileName}
            </a>
            ${askBtn}
        </span>
    `;
}

function formatAIAnswer(text) {
    if (!text) return '';

    let safe = escapeHtml(text);

    // Code inline: `abc`
    safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **abc**
    safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Italic: *abc*
    safe = safe.replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');

    const lines = safe.split('\n');
    let html = '';
    let inList = false;

    lines.forEach(line => {
        const trimmed = line.trim();

        if (!trimmed) {
            if (inList) {
                html += '</ul>';
                inList = false;
            }
            html += '<br>';
            return;
        }

        // Heading markdown
        if (trimmed.startsWith('### ')) {
            if (inList) {
                html += '</ul>';
                inList = false;
            }
            html += `<h4>${trimmed.replace(/^###\s+/, '')}</h4>`;
            return;
        }

        if (trimmed.startsWith('## ')) {
            if (inList) {
                html += '</ul>';
                inList = false;
            }
            html += `<h3>${trimmed.replace(/^##\s+/, '')}</h3>`;
            return;
        }

        if (trimmed.startsWith('# ')) {
            if (inList) {
                html += '</ul>';
                inList = false;
            }
            html += `<h3>${trimmed.replace(/^#\s+/, '')}</h3>`;
            return;
        }

        // Bullet list: - item hoặc * item
        if (/^[-*]\s+/.test(trimmed)) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }

            html += `<li>${trimmed.replace(/^[-*]\s+/, '')}</li>`;
            return;
        }

        // Numbered list: 1. item
        if (/^\d+\.\s+/.test(trimmed)) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }

            html += `<li>${trimmed.replace(/^\d+\.\s+/, '')}</li>`;
            return;
        }

        if (inList) {
            html += '</ul>';
            inList = false;
        }

        html += `<p>${trimmed}</p>`;
    });

    if (inList) {
        html += '</ul>';
    }

    return html;
}

function showDocumentAIPanel() {
    const panel = document.getElementById('document-ai-panel');
    const split = document.getElementById('chatroom-main-split');

    if (panel) panel.style.display = 'flex';
    if (split) split.classList.add('document-ai-open');
}

function setDocumentAIView(view) {
    documentAIMode = view;

    const listView = document.getElementById('document-ai-list-view');
    const createView = document.getElementById('document-ai-create-view');
    const chatView = document.getElementById('document-ai-chat-view');
    const backBtn = document.getElementById('btn-document-ai-back');

    if (listView) listView.style.display = view === 'list' ? 'flex' : 'none';
    if (createView) createView.style.display = view === 'create' ? 'flex' : 'none';
    if (chatView) chatView.style.display = view === 'chat' ? 'flex' : 'none';

    if (backBtn) {
        backBtn.style.display = view === 'chat' || view === 'create' ? 'inline-flex' : 'none';
    }
}

async function openRoomDocumentAIList() {
    if (!currentChatroom) return;

    if (currentChatroom.room_type === 'voice') {
        closeDocumentAIPanelOnly();
        return;
    }

    showDocumentAIPanel();
    setDocumentAIView('list');

    const titleEl = document.getElementById('document-ai-file-name');
    if (titleEl) {
        titleEl.textContent = 'Danh sách cuộc trò chuyện';
    }

    await loadAIConversationList();
}

async function loadAIConversationList() {
    if (!currentChatroom) return;

    const listEl = document.getElementById('document-ai-conversation-list');

    if (listEl) {
        listEl.innerHTML = `
            <div class="document-ai-loading">
                <i class="fas fa-spinner fa-spin"></i> Đang tải...
            </div>
        `;
    }

    try {
        const data = await apiCall(
            `/channels/chatrooms/${currentChatroom.room_id}/ai-conversations`
        );

        aiConversationList = data.conversations || [];

        renderAIConversationList();

    } catch (err) {
        if (listEl) {
            listEl.innerHTML = `
                <div class="document-ai-empty">
                    Lỗi tải danh sách: ${escapeHtml(err.message)}
                </div>
            `;
        }
    }
}

function renderAIConversationList() {
    const listEl = document.getElementById('document-ai-conversation-list');
    if (!listEl) return;

    if (!aiConversationList.length) {
        listEl.innerHTML = `
            <div class="document-ai-empty">
                Chưa có cuộc trò chuyện nào trong phòng này.
            </div>
        `;
        return;
    }

    listEl.innerHTML = aiConversationList.map(conv => {
        const docs = conv.documents || [];
        const docCount = docs.length;
        const updatedAt = conv.updated_at || conv.created_at;

        return `
            <div class="document-ai-conversation-row">
                <button
                    type="button"
                    class="document-ai-conversation-item"
                    onclick="openAIConversation('${escapeJsString(conv.conversation_id)}')">
                    <div class="ai-conv-icon">
                        <i class="fas fa-comments"></i>
                    </div>

                    <div class="ai-conv-main">
                        <div class="ai-conv-title">${escapeHtml(conv.title || 'Cuộc trò chuyện')}</div>
                        <div class="ai-conv-meta">
                            ${docCount} tài liệu · ${formatDateTime(updatedAt)}
                        </div>
                        <div class="ai-conv-docs">
                            ${escapeHtml(docs.slice(0, 3).map(d => d.file_name).join(', '))}
                        </div>
                    </div>
                </button>

                <button
                    type="button"
                    class="btn-rename-ai-conversation"
                    title="Đổi tên cuộc trò chuyện"
                    onclick="renameAIConversation(event, '${escapeJsString(conv.conversation_id)}', '${escapeJsString(conv.title || 'Cuộc trò chuyện')}')">
                    <i class="fas fa-pen"></i>
                </button>

                <button
                    type="button"
                    class="btn-delete-ai-conversation"
                    title="Xóa cuộc trò chuyện"
                    onclick="deleteAIConversation(event, '${escapeJsString(conv.conversation_id)}')">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
    }).join('');
}

document.getElementById('btn-room-document-ai')?.addEventListener('click', openRoomDocumentAIList);

async function renameAIConversation(event, conversationId, currentTitle) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    if (!conversationId) return;

    const newTitle = prompt(
        'Nhập tên mới cho cuộc trò chuyện:',
        currentTitle || ''
    );

    if (newTitle === null) return;

    const title = newTitle.trim();

    if (!title) {
        showToast('Tên cuộc trò chuyện không được để trống', 'warning');
        return;
    }

    try {
        const result = await apiCall(
            `/channels/ai-conversations/${conversationId}/rename`,
            'PATCH',
            {
                title
            }
        );

        showToast('Đã đổi tên cuộc trò chuyện', 'success');

        if (
            currentAIConversation &&
            currentAIConversation.conversation_id === conversationId
        ) {
            currentAIConversation.title = result.title || title;

            const titleEl = document.getElementById('document-ai-file-name');
            if (titleEl) {
                const docs = currentAIConversation.documents || [];
                titleEl.textContent = `${currentAIConversation.title} · ${docs.length} tài liệu`;
            }
        }

        await loadAIConversationList();

    } catch (err) {
        showToast('Lỗi đổi tên cuộc trò chuyện: ' + err.message, 'error');
    }
}

async function handleDocumentAIWhenChatroomChanged() {
    if (!currentChatroom) return;

    const isVoiceRoom = currentChatroom.room_type === 'voice';

    // Nếu chuyển sang voice room thì tự đóng AI panel
    if (isVoiceRoom) {
        closeDocumentAIPanelOnly();
        return;
    }

    const panel = document.getElementById('document-ai-panel');
    const isPanelOpen = panel && panel.style.display !== 'none';

    if (!isPanelOpen) return;

    // Nếu panel đang mở, chuyển về danh sách cuộc trò chuyện của room mới
    currentAIConversation = null;

    setDocumentAIView('list');

    const titleEl = document.getElementById('document-ai-file-name');
    if (titleEl) {
        titleEl.textContent = 'Danh sách cuộc trò chuyện';
    }

    await loadAIConversationList();
}

async function deleteAIConversation(event, conversationId) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    if (!conversationId) return;

    const ok = confirm('Bạn có chắc muốn xóa cuộc trò chuyện này không?');

    if (!ok) return;

    try {
        await apiCall(
            `/channels/ai-conversations/${conversationId}`,
            'DELETE'
        );

        showToast('Đã xóa cuộc trò chuyện', 'success');

        if (
            currentAIConversation &&
            currentAIConversation.conversation_id === conversationId
        ) {
            currentAIConversation = null;
            setDocumentAIView('list');
        }

        await loadAIConversationList();

    } catch (err) {
        showToast('Lỗi xóa cuộc trò chuyện: ' + err.message, 'error');
    }
}

async function openAIConversation(conversationId) {
    if (!conversationId) return;

    showDocumentAIPanel();
    setDocumentAIView('chat');

    const messagesEl = document.getElementById('document-ai-messages');

    if (messagesEl) {
        messagesEl.innerHTML = `
            <div class="document-ai-msg assistant">
                <div class="document-ai-bubble">Đang tải cuộc trò chuyện...</div>
            </div>
        `;
    }

    try {
        const data = await apiCall(
            `/channels/ai-conversations/${conversationId}`
        );

        currentAIConversation = data.conversation;

        const titleEl = document.getElementById('document-ai-file-name');
        if (titleEl) {
            const docs = currentAIConversation.documents || [];
            titleEl.textContent = `${currentAIConversation.title || 'Cuộc trò chuyện'} · ${docs.length} tài liệu`;
        }

        renderDocumentAIHistory(data.messages || []);

    } catch (err) {
        showToast('Lỗi mở cuộc trò chuyện: ' + err.message, 'error');
        setDocumentAIView('list');
    }
}

function backToAIConversationList() {
    currentAIConversation = null;
    setDocumentAIView('list');

    const titleEl = document.getElementById('document-ai-file-name');
    if (titleEl) titleEl.textContent = 'Danh sách cuộc trò chuyện';

    loadAIConversationList();
}

document.getElementById('btn-document-ai-back')?.addEventListener('click', () => {
    if (documentAIMode === 'chat' || documentAIMode === 'create') {
        backToAIConversationList();
    }
});

function openCreateAIConversationView() {
    setDocumentAIView('create');

    const titleEl = document.getElementById('document-ai-file-name');
    if (titleEl) titleEl.textContent = 'Nhập tài liệu';

    const titleInput = document.getElementById('ai-conversation-title');
    const fileInput = document.getElementById('ai-conversation-files');
    const selectedEl = document.getElementById('ai-conversation-selected-files');

    if (titleInput) titleInput.value = '';
    if (fileInput) fileInput.value = '';
    if (selectedEl) selectedEl.innerHTML = '';
}

document.getElementById('btn-create-ai-conversation')?.addEventListener('click', openCreateAIConversationView);
document.getElementById('btn-cancel-create-ai-conversation')?.addEventListener('click', backToAIConversationList);

document.getElementById('ai-conversation-files')?.addEventListener('change', function () {
    const selectedEl = document.getElementById('ai-conversation-selected-files');
    if (!selectedEl) return;

    const files = Array.from(this.files || []);

    if (!files.length) {
        selectedEl.innerHTML = '';
        return;
    }

    selectedEl.innerHTML = files.map(file => `
        <div class="ai-selected-file-item">
            <i class="fas fa-file"></i>
            <span>${escapeHtml(file.name)}</span>
            <small>${formatFileSize(file.size)}</small>
        </div>
    `).join('');
});

async function uploadAIConversationFile(file) {
    const token = getToken();
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(
        `${API_URL}/channels/chatrooms/${currentChatroom.room_id}/upload`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            },
            body: formData
        }
    );

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(extractErrorMessage(errData, 'Upload failed'));
    }

    const data = await response.json();

    if (data.file_id) {
        aiFileSizeCache[data.file_id] = file.size;
    }

    return {
        file_id: data.file_id,
        file_name: file.name,
        message_id: null,
        source: 'upload',
        file_size: file.size
    };
}

async function submitCreateAIConversation() {
    if (!currentChatroom) return;

    const titleInput = document.getElementById('ai-conversation-title');
    const fileInput = document.getElementById('ai-conversation-files');
    const submitBtn = document.getElementById('btn-submit-create-ai-conversation');

    const title = (titleInput?.value || '').trim();
    const files = Array.from(fileInput?.files || []);

    if (!title) {
        showToast('Vui lòng nhập tên cuộc trò chuyện', 'warning');
        return;
    }

    if (!files.length) {
        showToast('Vui lòng chọn ít nhất một tài liệu', 'warning');
        return;
    }

    for (const file of files) {
        const allowed = await canAnalyzeFileWithUTEZoneAI(
            null,
            file.name,
            file.size
        );

        if (!allowed) {
            return;
        }
    }

    const oldHtml = submitBtn ? submitBtn.innerHTML : '';

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang xử lý...';
        }

        const uploadedDocs = [];

        for (const file of files) {
            const uploaded = await uploadAIConversationFile(file);
            uploadedDocs.push(uploaded);
        }

        const conversation = await apiCall(
            `/channels/chatrooms/${currentChatroom.room_id}/ai-conversations`,
            'POST',
            {
                title,
                documents: uploadedDocs
            }
        );

        showToast('Đã tạo cuộc trò chuyện với UTEZoneAI', 'success');

        await openAIConversation(conversation.conversation_id);

    } catch (err) {
        showToast('Lỗi tạo cuộc trò chuyện: ' + err.message, 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = oldHtml || 'Xong';
        }
    }
}

document.getElementById('btn-submit-create-ai-conversation')?.addEventListener('click', submitCreateAIConversation);

async function applyMuteStatusForCurrentChannel() {
    if (!currentChannel) return;

    try {
        const data = await apiCall(`/channels/${currentChannel.channel_id}/mute-status`);

        if (data.muted) {
            currentMuteState = {
                muted: true,
                channel_id: currentChannel.channel_id,
                reason: data.reason || 'Bạn đang bị cấm gửi tin nhắn trong kênh này',
                muted_until: data.muted_until || null
            };

            syncMuteControls();
            scheduleMuteUnlock(data.muted_until);
        } else {
            enableChatInputIfNotMuted();
        }
    } catch (err) {
        console.error('Load mute status error:', err);
        enableChatInputIfNotMuted();
    }
}

// ====== Select Channel ======
function updateOwnerControls() {
    const isOwner = currentChannel && currentChannel.is_owner;

    const createChatroomBtn = document.getElementById('btn-create-chatroom');
    const channelSettingsBtn = document.getElementById('btn-channel-settings');
    const chatroomSettingsBtn = document.getElementById('btn-chatroom-settings');

    if (createChatroomBtn) {
        createChatroomBtn.style.display = isOwner ? 'inline-flex' : 'none';
    }

    // Thành viên vẫn được xem cài đặt kênh dạng chỉ đọc
    if (channelSettingsBtn) {
        channelSettingsBtn.style.display = currentChannel ? 'inline-flex' : 'none';
    }

    if (chatroomSettingsBtn) {
        chatroomSettingsBtn.style.display = (isOwner && currentChatroom) ? 'inline-flex' : 'none';
    }
}

async function selectChannel(channelId) {
    try {
        const data = await apiCall('/channels/' + channelId);

        currentChannel = data;
        currentChatroom = null;
        messageList = [];

        enableChatInputIfNotMuted();

        stopMessagePolling();
        stopMemberPolling();
        stopChatroomPolling();

        updateOwnerControls();

        const emptyInner = document.getElementById('chatroom-empty-inner');
        const activeDiv = document.getElementById('chatroom-active');

        if (emptyInner) emptyInner.style.display = 'flex';
        if (activeDiv) activeDiv.style.display = 'none';

        const messagesContainer = document.getElementById('chatroom-messages');
        if (messagesContainer) messagesContainer.innerHTML = '';

        await setUserSession(channelId, null);

        currentOnlineUsers = [];

        await renderChannelDetail();
        await applyMuteStatusForCurrentChannel();

        renderChannelList();

        await loadChatrooms(channelId);
        await loadUnreadCounts(channelId);
        await loadChannelRules();

        await loadMembers(channelId);

        connectChannelWebsocket(channelId);

        // handleReturnFromMeeting();

        return currentChannel;
    } catch (err) {
        console.error('Select channel error:', err);

        showToast('Không thể tải thông tin kênh: ' + err.message, 'error');

        if (err.message.includes('404') || err.message.includes('không tồn tại')) {
            const url = new URL(window.location);
            url.searchParams.delete('channel');
            url.searchParams.delete('chatroom');
            url.searchParams.delete('return');
            window.history.replaceState({}, '', url);
        }

        throw err;
    }
}

async function renderChannelDetail() {
    document.getElementById('channel-empty').style.display = 'none';
    document.getElementById('channel-detail').style.display = 'flex';

    const avatarContainer = document.getElementById('channel-avatar');
    if (avatarContainer) {
        if (currentChannel.avatar) {
            let url = await getChannelAvatarUrl(currentChannel.avatar);
            if (url) avatarContainer.innerHTML = `<img src="${url}" class="channel-avatar-img" style="width:40px;height:40px;border-radius:50%;object-fit:cover;">`;
            else avatarContainer.innerHTML = '<i class="fas fa-hashtag"></i>';
        } else {
            avatarContainer.innerHTML = '<i class="fas fa-hashtag"></i>';
        }
    }

    document.getElementById('channel-name').textContent = currentChannel.name;
    document.getElementById('channel-description').textContent = currentChannel.description || 'Không có mô tả';
    const memberCount = currentChannel.member_count || (memberList ? memberList.length : 0);
    document.getElementById('member-count').innerHTML = '<i class="fas fa-users"></i> <span>' + memberCount + '</span>';

    const leaveBtn = document.getElementById('btn-leave-channel');
    if (currentChannel.is_owner) {
        leaveBtn.title = 'Xóa kênh';
        leaveBtn.innerHTML = '<i class="fas fa-trash"></i>';
    } else {
        leaveBtn.title = 'Rời kênh';
        leaveBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i>';
    }
}

// ====== Chatrooms ======
function loadChatrooms(channelId) {
    return apiCall('/channels/' + channelId + '/chatrooms').then(function (data) {
        chatroomList = data.chatrooms || data || [];
        renderChatroomList();
    }).catch(function (err) {
        console.error('Load chatrooms error:', err);
        chatroomList = [];
        renderChatroomList();
    });
}

function renderChatroomList() {
    var container = document.getElementById('chatroom-list');
    if (!chatroomList.length) { container.innerHTML = '<div class="empty-chatrooms">Chưa có phòng chat nào</div>'; return; }
    var textRooms = chatroomList.filter(r => r.room_type === 'text' || !r.room_type);
    var voiceRooms = chatroomList.filter(r => r.room_type === 'voice');
    var html = '';
    if (textRooms.length) {
        html += '<div class="chatroom-group"><div class="chatroom-group-title"><i class="fas fa-hashtag"></i> Trò chuyện</div>';
        textRooms.forEach(r => {
            var isActive = currentChatroom && currentChatroom.room_id === r.room_id ? ' active' : '';
            var unread = unreadCounts[r.room_id] || 0;
            var unreadBadge = unread > 0 ? '<span class="unread-badge"></span>' : '';
            html += `<div class="chatroom-item${isActive}" onclick="selectChatroom('${r.room_id}')">
                <span class="chatroom-item-icon"><i class="fas fa-hashtag"></i></span>
                <span class="chatroom-item-name">${escapeHtml(r.name)}</span>${unreadBadge}
            </div>`;
        });
        html += '</div>';
    }
    if (voiceRooms.length) {
        html += '<div class="chatroom-group"><div class="chatroom-group-title"><i class="fas fa-volume-up"></i> Họp</div>';
        voiceRooms.forEach(r => {
            var isActive = currentChatroom && currentChatroom.room_id === r.room_id ? ' active' : '';
            var unread = unreadCounts[r.room_id] || 0;
            var unreadBadge = unread > 0 ? '<span class="unread-badge">*</span>' : '';
            var roomNameClass = unread > 0 ? 'chatroom-item-name unread' : 'chatroom-item-name';
            html += `<div class="chatroom-item${isActive}" onclick="selectChatroom('${r.room_id}')">
                <span class="chatroom-item-icon"><i class="fas fa-volume-up"></i></span>
                <span class="${roomNameClass}">${escapeHtml(r.name)}${unreadBadge}</span>
            </div>`;
        });
        html += '</div>';
    }
    container.innerHTML = html;
}

// ====== Select Chatroom ======
function selectChatroom(roomId) {
    function applyRoom(room) {
        currentChatroom = room;
        updateOwnerControls();
        messageList = [];
        renderChatroomActive();
        renderChatroomList();
        syncMuteControls();
        setTimeout(syncMuteControls, 0);
        if (currentChatroom.room_type === 'voice') {
            stopMessagePolling();
            renderVoiceRoom();
        } else {
            refreshMessages();
        }

        handleDocumentAIWhenChatroomChanged();
    }
    apiCall(`/channels/chatrooms/${roomId}/mark-read`, 'POST').catch(console.error);
    if (unreadCounts[roomId]) {
        delete unreadCounts[roomId];
        renderChatroomList();
    }
    if (chatroomList.length > 0) {
        let found = chatroomList.find(r => String(r.room_id) === String(roomId));
        if (found) { applyRoom(found); return; }
        console.warn('Room not in list, fetching from API');
        apiCall('/channels/chatrooms/' + roomId).then(room => applyRoom(room)).catch(err => applyRoom({ room_id: roomId, name: 'Phòng chat', room_type: 'text' }));
    } else {
        apiCall('/channels/chatrooms/' + roomId).then(room => applyRoom(room)).catch(err => applyRoom({ room_id: roomId, name: 'Phòng chat', room_type: 'text' }));
    }
}

function renderChatroomActive() {
    if (!currentChatroom) return;
    const emptyInner = document.getElementById('chatroom-empty-inner');
    if (emptyInner) emptyInner.style.display = 'none';
    const activeDiv = document.getElementById('chatroom-active');
    if (activeDiv) activeDiv.style.display = 'flex';
    const nameEl = document.getElementById('chatroom-name');
    if (nameEl) nameEl.textContent = currentChatroom.name;
    const descEl = document.getElementById('chatroom-desc');
    if (descEl) descEl.textContent = currentChatroom.description || '';
    const welcomeEl = document.getElementById('welcome-room-name');
    if (welcomeEl) welcomeEl.textContent = currentChatroom.name;
    const typeIconEl = document.getElementById('chatroom-type-icon');
    if (typeIconEl) typeIconEl.innerHTML = currentChatroom.room_type === 'voice' ? '<i class="fas fa-volume-up"></i>' : '<i class="fas fa-hashtag"></i>';
    const startBtn = document.getElementById('btn-start-meeting');
    if (startBtn) startBtn.style.display = 'none';
    updateMediaButtonsVisibility();
    syncMuteControls();
}

function renderVoiceRoom() {
    var messagesContainer = document.getElementById('chatroom-messages');
    if (!messagesContainer) return;
    var inputArea = document.querySelector('.chatroom-input-area');
    if (inputArea) inputArea.style.display = 'none';
    messagesContainer.innerHTML = '';
    var html = '<div class="voice-room"><div class="voice-room-header"><i class="fas fa-volume-up" style="font-size:48px;color:#323cae;"></i><h3>' + escapeHtml(currentChatroom.name) + '</h3><p>' + escapeHtml(currentChatroom.description || 'Phòng họp') + '</p></div><div class="voice-room-actions"><button class="btn-join-voice" id="btn-join-voice" onclick="joinVoiceRoom()"><i class="fas fa-headphones"></i> Tham gia họp</button></div></div>';
    messagesContainer.innerHTML = html;
}

var isInVoiceRoom = false;
function joinVoiceRoom() {
    if (!currentChatroom) return;
    sessionStorage.setItem('lastVoiceChannel', currentChannel.channel_id);
    sessionStorage.setItem('lastVoiceRoom', currentChatroom.room_id);
    apiCall('/channels/chatrooms/' + currentChatroom.room_id + '/start-meeting', 'POST').then(data => {
        location.href = `/room.html?room=${data.room_id}&channel=${currentChannel.channel_id}&chatroom=${currentChatroom.room_id}`;
    }).catch(err => showToast('Lỗi tham gia phòng họp: ' + err.message, 'error'));
}

async function appendNewMessages(newMessages) {
    const container = document.getElementById('chatroom-messages');
    if (!container || !newMessages || newMessages.length === 0) return;

    // Xóa dòng "chưa có tin nhắn" nếu đang hiển thị
    const noMessagesEl = container.querySelector('.no-messages');
    if (noMessagesEl) noMessagesEl.remove();

    // Lấy avatar cho các sender chưa có cache
    for (let msg of newMessages) {
        if (msg.sender_email && !avatarCache[msg.sender_email]) {
            await getUserAvatar(msg.sender_email);
        }
    }

    // Lấy URL cho file/image/video chưa có cache
    const fileMessages = newMessages.filter(m =>
        m.msg_type !== 'text' &&
        m.content &&
        !fileUrlCache[m.content]
    );

    for (let msg of fileMessages) {
        try {
            const urlData = await apiCall(`/channels/files/${msg.content}`);
            fileUrlCache[msg.content] = urlData.url;
        } catch (err) {
            console.error(`Lỗi lấy URL cho ${msg.content}:`, err);
            fileUrlCache[msg.content] = null;
        }
    }

    const wasAtBottom = (container.scrollHeight - container.scrollTop) <= (container.clientHeight + 50);

    let html = '';

    // Tìm ngày cuối cùng đang hiển thị để append separator đúng
    let currentDate = '';
    const separators = container.querySelectorAll('.message-date-separator span');
    if (separators.length > 0) {
        currentDate = separators[separators.length - 1].textContent;
    }

    newMessages.forEach(msg => {
        // Nếu DOM đã có message này rồi thì bỏ qua
        if (msg.message_id) {
            const existed = container.querySelector(`.message-item[data-message-id="${msg.message_id}"]`);
            if (existed) return;
        }

        const msgDate = formatDate(msg.created_at);

        if (msgDate !== currentDate) {
            currentDate = msgDate;
            html += `<div class="message-date-separator"><span>${msgDate}</span></div>`;
        }

        const isOwn = msg.sender_email === getCurrentUserEmail();
        const msgType = msg.msg_type || 'text';
        const fileUrl = (msgType !== 'text' && msg.content && fileUrlCache[msg.content])
            ? fileUrlCache[msg.content]
            : null;

        let contentHtml = '';

        if (msgType === 'image') {
            contentHtml = fileUrl
                ? `<img src="${fileUrl}" style="max-width:250px; max-height:250px; border-radius:8px; cursor:pointer;" onclick="window.open('${fileUrl}')" />`
                : '<span class="file-placeholder">Đang tải ảnh...</span>';
        } else if (msgType === 'video') {
            contentHtml = fileUrl
                ? `<video src="${fileUrl}" controls style="max-width:250px; border-radius:8px;"></video>`
                : '<span class="file-placeholder">Đang tải video...</span>';
        } else if (msgType === 'file') {
            if (fileUrl) {
                contentHtml = renderFileMessageContent(msg, fileUrl);
            } else {
                contentHtml = '<span class="file-placeholder">Đang tải file...</span>';
            }
        } else {
            contentHtml = escapeHtml(msg.content || '');
        }

        const avatarUrl = avatarCache[msg.sender_email];
        const avatarHtml = avatarUrl
            ? `<img src="${avatarUrl}" class="message-avatar-img" onerror="this.onerror=null;this.style.display='none';this.nextSibling.style.display='flex'">`
            : '';

        const letterHtml = `
            <div class="message-avatar-letter" style="${avatarUrl ? 'display:none' : 'display:flex'}">
                ${getAvatarLetter(msg.sender_name || msg.sender_email)}
            </div>
        `;

        const messageIdAttr = msg.message_id ? `data-message-id="${msg.message_id}"` : '';
        const tempIdAttr = msg.message_id && msg.message_id.startsWith('temp_')
            ? `data-temp-id="${msg.message_id}"`
            : '';

        const canDeleteMessage =
            currentChannel &&
            currentChannel.is_owner &&
            msg.message_id &&
            !msg.message_id.startsWith('temp_');

        const deleteButtonHtml = canDeleteMessage
            ? `
                <button 
                    type="button"
                    class="message-delete-btn"
                    title="Xóa tin nhắn"
                    onclick="event.stopPropagation(); deleteChatMessage('${String(msg.message_id).replace(/'/g, "\\'")}')">
                    <i class="fas fa-trash"></i>
                </button>
            `
            : '';

        html += `
            <div class="message-item${isOwn ? ' own' : ''}" ${messageIdAttr} ${tempIdAttr}>
                <div 
                    class="message-avatar clickable-avatar"
                    title="Xem trang cá nhân"
                    onclick="event.stopPropagation(); viewProfile('${String(msg.sender_email || '').replace(/'/g, "\\'")}')">
                    ${avatarHtml}${letterHtml}
                </div>

                <div class="message-content">
                    <div class="message-header">
                        <span class="message-sender">${escapeHtml(msg.sender_name || msg.sender_email)}</span>
                        <span class="message-time">${formatTime(msg.created_at)}</span>
                        ${deleteButtonHtml}
                    </div>

                    <div class="message-text">${contentHtml}</div>
                </div>
            </div>
        `;
    });

    if (html.trim()) {
        container.insertAdjacentHTML('beforeend', html);
    }

    if (wasAtBottom) {
        container.scrollTop = container.scrollHeight;
    }
}

let lastLoadedMessageId = null;
async function loadMessages() {
    if (!currentChatroom) return;
    try {
        const data = await apiCall('/channels/chatrooms/' + currentChatroom.room_id + '/messages?limit=50');
        const newMessages = data.messages || [];
        if (newMessages.length === 0) return;
        const fileMessages = newMessages.filter(m => m.msg_type !== 'text');
        for (let msg of fileMessages) {
            if (msg.content && !fileUrlCache[msg.content]) {
                try { const urlData = await apiCall(`/channels/files/${msg.content}`); fileUrlCache[msg.content] = urlData.url; }
                catch (err) { console.error(`Lỗi lấy URL cho ${msg.content}:`, err); fileUrlCache[msg.content] = null; }
            }
        }
        if (messageList.length === 0) { messageList = newMessages; renderMessages(); return; }
        const existingIds = new Set(messageList.map(m => m.message_id));
        const addedMessages = newMessages.filter(m => !existingIds.has(m.message_id));
        if (addedMessages.length > 0) { messageList.push(...addedMessages); appendNewMessages(addedMessages); }
    } catch (err) { console.error('Load messages error:', err); }
}

async function renderMessages() {
    if (!currentChatroom) return;

    const container = document.getElementById('chatroom-messages');
    if (!container) return;

    // Lấy avatar cho các sender chưa có cache
    for (let msg of messageList) {
        if (msg.sender_email && !avatarCache[msg.sender_email]) {
            await getUserAvatar(msg.sender_email);
        }
    }

    // Lấy URL cho các file/image/video chưa có cache
    const fileMessages = messageList.filter(m =>
        m.msg_type !== 'text' &&
        m.content &&
        !fileUrlCache[m.content]
    );

    for (let msg of fileMessages) {
        try {
            const urlData = await apiCall(`/channels/files/${msg.content}`);
            fileUrlCache[msg.content] = urlData.url;
        } catch (err) {
            console.error(`Lỗi lấy URL cho ${msg.content}:`, err);
            fileUrlCache[msg.content] = null;
        }
    }

    const inputArea = document.querySelector('.chatroom-input-area');
    if (inputArea && currentChatroom && currentChatroom.room_type !== 'voice') {
        inputArea.style.display = 'flex';

        // renderMessages có thể làm khu vực nhập hiện lại,
        // nên phải ép lại trạng thái mute ngay sau đó.
        syncMuteControls();
    }

    const savedScrollTop = container.scrollTop;
    const wasAtBottom = (container.scrollHeight - savedScrollTop) <= (container.clientHeight + 50);

    let html = `
        <div class="chat-welcome">
            <i class="fas fa-hashtag" style="font-size:40px;color:#323cae;"></i>
            <h3>Chào mừng đến <span id="welcome-room-name">${escapeHtml(currentChatroom.name)}</span></h3>
        </div>
    `;

    if (!messageList || messageList.length === 0) {
        html += '<div class="no-messages">Chưa có tin nhắn nào. Hãy gửi tin nhắn đầu tiên!</div>';
    } else {
        let currentDate = '';

        messageList.forEach(msg => {
            const msgDate = formatDate(msg.created_at);

            if (msgDate !== currentDate) {
                currentDate = msgDate;
                html += `<div class="message-date-separator"><span>${msgDate}</span></div>`;
            }

            const isOwn = msg.sender_email === getCurrentUserEmail();
            const msgType = msg.msg_type || 'text';
            const fileUrl = (msgType !== 'text' && msg.content && fileUrlCache[msg.content])
                ? fileUrlCache[msg.content]
                : null;

            let contentHtml = '';

            if (msgType === 'image') {
                contentHtml = fileUrl
                    ? `<img src="${fileUrl}" style="max-width:250px; max-height:250px; border-radius:8px; cursor:pointer;" onclick="window.open('${fileUrl}')" />`
                    : '<span class="file-placeholder">Đang tải ảnh...</span>';
            } else if (msgType === 'video') {
                contentHtml = fileUrl
                    ? `<video src="${fileUrl}" controls style="max-width:250px; border-radius:8px;"></video>`
                    : '<span class="file-placeholder">Đang tải video...</span>';
            } else if (msgType === 'file') {
                if (fileUrl) {
                    contentHtml = renderFileMessageContent(msg, fileUrl);
                } else {
                    contentHtml = '<span class="file-placeholder">Đang tải file...</span>';
                }
            } else {
                contentHtml = escapeHtml(msg.content || '');
            }

            const avatarUrl = avatarCache[msg.sender_email];
            const avatarHtml = avatarUrl
                ? `<img src="${avatarUrl}" class="message-avatar-img" onerror="this.onerror=null;this.style.display='none';this.nextSibling.style.display='flex'">`
                : '';

            const letterHtml = `
                <div class="message-avatar-letter" style="${avatarUrl ? 'display:none' : 'display:flex'}">
                    ${getAvatarLetter(msg.sender_name || msg.sender_email)}
                </div>
            `;

            const messageIdAttr = msg.message_id ? `data-message-id="${msg.message_id}"` : '';
            const tempIdAttr = msg.message_id && msg.message_id.startsWith('temp_')
                ? `data-temp-id="${msg.message_id}"`
                : '';

            const canDeleteMessage =
                currentChannel &&
                currentChannel.is_owner &&
                msg.message_id &&
                !msg.message_id.startsWith('temp_');

            const deleteButtonHtml = canDeleteMessage
                ? `
                    <button 
                        type="button"
                        class="message-delete-btn"
                        title="Xóa tin nhắn"
                        onclick="event.stopPropagation(); deleteChatMessage('${String(msg.message_id).replace(/'/g, "\\'")}')">
                        <i class="fas fa-trash"></i>
                    </button>
                `
                : '';

            html += `
                <div class="message-item${isOwn ? ' own' : ''}" ${messageIdAttr} ${tempIdAttr}>
                    <div 
                        class="message-avatar clickable-avatar"
                        title="Xem trang cá nhân"
                        onclick="event.stopPropagation(); viewProfile('${String(msg.sender_email || '').replace(/'/g, "\\'")}')">
                        ${avatarHtml}${letterHtml}
                    </div>

                    <div class="message-content">
                        <div class="message-header">
                            <span class="message-sender">${escapeHtml(msg.sender_name || msg.sender_email)}</span>
                            <span class="message-time">${formatTime(msg.created_at)}</span>
                            ${deleteButtonHtml}
                        </div>

                        <div class="message-text">${contentHtml}</div>
                    </div>
                </div>
            `;
        });
    }

    container.innerHTML = html;

    setTimeout(() => {
        if (wasAtBottom) {
            container.scrollTop = container.scrollHeight;
        } else if (savedScrollTop <= container.scrollHeight) {
            container.scrollTop = savedScrollTop;
        } else {
            container.scrollTop = container.scrollHeight;
        }
    }, 0);
}

function deleteChatMessage(messageId) {
    if (!currentChannel || !currentChannel.is_owner) {
        showToast('Bạn không có quyền xóa tin nhắn', 'error');
        return;
    }

    if (!messageId) {
        showToast('Không tìm thấy ID tin nhắn', 'error');
        return;
    }

    if (!confirm('Bạn có chắc muốn xóa tin nhắn này?')) {
        return;
    }

    apiCall(`/channels/messages/${encodeURIComponent(messageId)}`, 'DELETE')
        .then(() => {
            showToast('Đã xóa tin nhắn', 'success');

            // Xóa ngay trên UI của chủ channel, không cần chờ websocket
            messageList = messageList.filter(m => m.message_id !== messageId);

            const msgEl = document.querySelector(
                `.message-item[data-message-id="${messageId}"]`
            );

            if (msgEl) {
                msgEl.remove();
            }
        })
        .catch(err => {
            showToast('Lỗi xóa tin nhắn: ' + err.message, 'error');
        });
}

async function refreshMessages() {
    if (!currentChatroom) return;
    try {
        const data = await apiCall('/channels/chatrooms/' + currentChatroom.room_id + '/messages?limit=50');
        const newMessages = data.messages || [];
        for (let msg of newMessages) {
            if (msg.msg_type !== 'text' && msg.content && !fileUrlCache[msg.content]) {
                try { const urlData = await apiCall(`/channels/files/${msg.content}`); fileUrlCache[msg.content] = urlData.url; }
                catch (err) { console.error(`Lỗi lấy URL cho ${msg.content}:`, err); fileUrlCache[msg.content] = null; }
            }
        }
        messageList = newMessages;
        await renderMessages();
    } catch (err) { console.error('Refresh messages error:', err); showToast('Không thể tải tin nhắn', 'error'); }
}

function getCurrentUserEmail() {
    try { var token = getToken(); if (!token) return ''; var payload = JSON.parse(atob(token.split('.')[1])); return payload.sub || ''; }
    catch (e) { return ''; }
}
function getAvatarLetter(name) { if (!name) return '?'; var parts = name.trim().split(/\s+/); if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase(); return name[0].toUpperCase(); }
function formatTime(dateStr) { if (!dateStr) return ''; var d = new Date(dateStr); var hours = d.getHours().toString().padStart(2, '0'); var mins = d.getMinutes().toString().padStart(2, '0'); return hours + ':' + mins; }
function formatDate(dateStr) { if (!dateStr) return ''; var d = new Date(dateStr); var today = new Date(); var yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1); if (d.toDateString() === today.toDateString()) return 'Hôm nay'; if (d.toDateString() === yesterday.toDateString()) return 'Hôm qua'; var day = d.getDate().toString().padStart(2, '0'); var month = (d.getMonth() + 1).toString().padStart(2, '0'); var year = d.getFullYear(); return day + '/' + month + '/' + year; }
function formatDateTime(dateStr) {
    if (!dateStr) return '';

    const d = new Date(dateStr);

    const hours = d.getHours().toString().padStart(2, '0');
    const mins = d.getMinutes().toString().padStart(2, '0');

    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();

    return `${hours}:${mins} ${day}/${month}/${year}`;
}

function escapeJsString(value) {
    return String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}

function findMessageElementById(messageId) {
    const items = document.querySelectorAll('.message-item[data-message-id]');

    for (const item of items) {
        if (String(item.getAttribute('data-message-id')) === String(messageId)) {
            return item;
        }
    }

    return null;
}

async function loadMoreMessagesForJump() {
    if (!currentChatroom) return;

    const data = await apiCall(
        `/channels/chatrooms/${currentChatroom.room_id}/messages?limit=1000`
    );

    const messages = data.messages || [];

    const fileMessages = messages.filter(m =>
        m.msg_type !== 'text' &&
        m.content &&
        !fileUrlCache[m.content]
    );

    for (let msg of fileMessages) {
        try {
            const urlData = await apiCall(`/channels/files/${msg.content}`);
            fileUrlCache[msg.content] = urlData.url;
        } catch (err) {
            console.error(`Lỗi lấy URL cho ${msg.content}:`, err);
            fileUrlCache[msg.content] = null;
        }
    }

    messageList = messages;
    await renderMessages();

    await new Promise(resolve => setTimeout(resolve, 80));
}

async function jumpToChatMessage(messageId) {
    if (!messageId || !currentChatroom) {
        showToast('Không tìm thấy tin nhắn chứa file này', 'warning');
        return;
    }

    // Đóng modal danh sách file nếu đang mở
    const modal = document.getElementById('modal-media-files');
    if (modal) {
        modal.style.display = 'none';
    }

    let msgEl = findMessageElementById(messageId);

    // Nếu message chưa nằm trong DOM hiện tại thì load lại lịch sử rộng hơn
    if (!msgEl) {
        try {
            await loadMoreMessagesForJump();
            msgEl = findMessageElementById(messageId);
        } catch (err) {
            console.error('Jump message load error:', err);
            showToast('Không thể tải lịch sử tin nhắn', 'error');
            return;
        }
    }

    if (!msgEl) {
        showToast('Không tìm thấy tin nhắn chứa file này', 'warning');
        return;
    }

    const container = document.getElementById('chatroom-messages');

    if (container) {
        const top = msgEl.offsetTop - container.offsetTop - 80;

        container.scrollTo({
            top: Math.max(top, 0),
            behavior: 'smooth'
        });
    } else {
        msgEl.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    }

    msgEl.classList.add('message-jump-highlight');

    setTimeout(() => {
        msgEl.classList.remove('message-jump-highlight');
    }, 2500);
}

function startMessagePolling() { stopMessagePolling(); }
function stopMessagePolling() { if (messagePollingTimer) { clearInterval(messagePollingTimer); messagePollingTimer = null; } }

async function setUserSession(channelId, chatRoomId) {
    try { let url = `/channels/session/set?channel_id=${encodeURIComponent(channelId || '')}`; if (chatRoomId) url += `&chat_room_id=${encodeURIComponent(chatRoomId)}`; await apiCall(url, 'POST'); console.log('Session set successfully', { channelId, chatRoomId }); }
    catch (err) { console.error('Set session error:', err); }
}
async function clearUserSession() {
    try {
        stopPresencePing();
        stopChatroomPolling();
        stopMemberPolling();

        if (channelSocket) {
            channelSocket.close();
            channelSocket = null;
        }

        await apiCall('/channels/session/clear', 'POST');
    } catch (err) {
        console.error('Clear session error:', err);
    }
}

window.addEventListener('beforeunload', () => {
    stopPresencePing();
    stopUserPing();

    if (channelSocket) {
        channelSocket.close();
        channelSocket = null;
    }

    if (userSocket) {
        userSocket.close();
        userSocket = null;
    }
});

async function loadMembers(channelId) {
    if (!channelId) return;

    try {
        const membersData = await apiCall('/channels/' + channelId + '/members');
        const allMembers = membersData.members || membersData || [];

        const onlineEmailSet = new Set(
            (currentOnlineUsers || []).map(u => normalizeEmail(u.email))
        );

        memberList = allMembers.map(m => {
            const email = normalizeEmail(m.email);
            const onlineUser = (currentOnlineUsers || []).find(
                u => normalizeEmail(u.email) === email
            );

            return {
                ...m,
                is_online: onlineEmailSet.has(email),
                avatar: onlineUser?.avatar || m.avatar || null,
                username: onlineUser?.username || m.username || m.email,
                role: onlineUser?.role || m.role || 'member',
                status: onlineUser?.status || m.status || 'approved'
            };
        });

        // Nếu có user online trong snapshot nhưng chưa nằm trong membersData,
        // vẫn thêm tạm vào UI để tránh mất trạng thái online.
        (currentOnlineUsers || []).forEach(user => {
            if (!memberList.some(m => normalizeEmail(m.email) === normalizeEmail(user.email))) {
                memberList.push({
                    email: user.email,
                    username: user.username || user.email,
                    avatar: user.avatar || null,
                    role: user.role || 'member',
                    status: user.status || 'approved',
                    is_online: true
                });
            }
        });

        renderMembers();

        const memberCountEl = document.getElementById('member-count');
        if (currentChannel && currentChannel.channel_id === channelId && memberCountEl) {
            memberCountEl.innerHTML =
                '<i class="fas fa-users"></i> <span>' + memberList.length + '</span>';
        }
    } catch (err) {
        console.error('Load members error:', err);
        memberList = [];
        renderMembers();
    }
}

function setMemberOnline(user) {
    if (!user || !user.email) return;

    const email = normalizeEmail(user.email);

    const existedOnlineIndex = currentOnlineUsers.findIndex(
        u => normalizeEmail(u.email) === email
    );

    if (existedOnlineIndex >= 0) {
        currentOnlineUsers[existedOnlineIndex] = {
            ...currentOnlineUsers[existedOnlineIndex],
            ...user
        };
    } else {
        currentOnlineUsers.push(user);
    }

    const existing = memberList.find(m => normalizeEmail(m.email) === email);

    if (existing) {
        existing.is_online = true;
        if (user.username) existing.username = user.username;
        if (user.avatar) existing.avatar = user.avatar;
        if (user.role) existing.role = user.role;
        if (user.status) existing.status = user.status;
    } else {
        memberList.push({
            email: user.email,
            username: user.username || user.email,
            avatar: user.avatar || null,
            role: user.role || 'member',
            status: user.status || 'approved',
            is_online: true
        });
    }

    renderMembers();
}

function setMemberOffline(userEmail) {
    const email = normalizeEmail(userEmail);

    currentOnlineUsers = currentOnlineUsers.filter(
        u => normalizeEmail(u.email) !== email
    );

    const existing = memberList.find(m => normalizeEmail(m.email) === email);

    if (existing) {
        existing.is_online = false;
        renderMembers();
    }
}

function applyOnlineSnapshot(onlineUsers) {
    currentOnlineUsers = onlineUsers || [];

    const onlineEmailSet = new Set(
        currentOnlineUsers.map(u => normalizeEmail(u.email))
    );

    memberList = memberList.map(m => {
        const email = normalizeEmail(m.email);
        const onlineUser = currentOnlineUsers.find(
            u => normalizeEmail(u.email) === email
        );

        return {
            ...m,
            is_online: onlineEmailSet.has(email),
            avatar: onlineUser?.avatar || m.avatar || null,
            username: onlineUser?.username || m.username || m.email,
            role: onlineUser?.role || m.role || 'member',
            status: onlineUser?.status || m.status || 'approved'
        };
    });

    currentOnlineUsers.forEach(user => {
        if (!memberList.some(m => normalizeEmail(m.email) === normalizeEmail(user.email))) {
            memberList.push({
                email: user.email,
                username: user.username || user.email,
                avatar: user.avatar || null,
                role: user.role || 'member',
                status: user.status || 'approved',
                is_online: true
            });
        }
    });

    renderMembers();
}

function startMemberPolling(channelId) {
    // Không dùng polling online member nữa. Online/offline được cập nhật qua WebSocket presence.
}

function stopMemberPolling() {
    if (memberPollingTimer) {
        clearInterval(memberPollingTimer);
        memberPollingTimer = null;
    }
}

function renderMembers() {
    var onlineList = document.getElementById('online-members-list');
    var offlineList = document.getElementById('offline-members-list');
    var pendingSection = document.getElementById('members-pending');
    var pendingList = document.getElementById('pending-members-list');

    if (!onlineList || !offlineList || !pendingSection || !pendingList) return;

    var onlineMembers = memberList.filter(m => m.is_online && m.status !== 'pending');
    var offlineMembers = memberList.filter(m => !m.is_online && m.status !== 'pending');
    var pendingMembers = memberList.filter(m => m.status === 'pending');

    onlineList.innerHTML =
        onlineMembers.map(m => renderMemberItem(m)).join('') ||
        '<div class="no-members">Không có</div>';

    offlineList.innerHTML =
        offlineMembers.map(m => renderMemberItem(m)).join('') ||
        '<div class="no-members">Không có</div>';

    if (pendingMembers.length > 0 && currentChannel && currentChannel.is_owner) {
        pendingSection.style.display = 'block';

        pendingList.innerHTML = pendingMembers.map(m => {
            const rawEmail = m.email || '';
            const safeEmail = escapeHtml(rawEmail);
            const username = escapeHtml(m.username || rawEmail || 'User');

            return `
                <div 
                    class="member-item pending pending-member-row" 
                    data-email="${safeEmail}"
                    style="
                        display:flex !important;
                        align-items:center !important;
                        gap:8px !important;
                        width:100% !important;
                        min-width:0 !important;
                        overflow:visible !important;
                        box-sizing:border-box !important;
                    "
                >
                    <div 
                        class="member-avatar"
                        style="
                            flex:0 0 36px !important;
                            width:36px !important;
                            height:36px !important;
                        "
                    >
                        <i class="fas fa-user-clock"></i>
                    </div>

                    <div 
                        class="member-info"
                        style="
                            flex:1 1 auto !important;
                            min-width:0 !important;
                            overflow:hidden !important;
                        "
                    >
                        <span 
                            class="member-name"
                            style="
                                display:block !important;
                                white-space:nowrap !important;
                                overflow:hidden !important;
                                text-overflow:ellipsis !important;
                            "
                        >${username}</span>

                        <span 
                            class="member-role"
                            style="
                                display:block !important;
                                white-space:nowrap !important;
                            "
                        >Chờ duyệt</span>
                    </div>

                    <div 
                        class="pending-actions"
                        style="
                            flex:0 0 auto !important;
                            display:flex !important;
                            align-items:center !important;
                            justify-content:flex-end !important;
                            gap:6px !important;
                            overflow:visible !important;
                            white-space:nowrap !important;
                        "
                    >
                        <button 
                            type="button"
                            class="pending-accept-btn"
                            title="Chấp nhận"
                            onclick="event.stopPropagation(); approveMember('${rawEmail.replace(/'/g, "\\'")}')"
                            style="
                                display:inline-flex !important;
                                align-items:center !important;
                                justify-content:center !important;
                                width:32px !important;
                                height:32px !important;
                                min-width:32px !important;
                                border:none !important;
                                border-radius:50% !important;
                                background:#2ecc71 !important;
                                color:white !important;
                                cursor:pointer !important;
                                padding:0 !important;
                                margin:0 !important;
                                flex:0 0 32px !important;
                            "
                        >
                            <i class="fas fa-check"></i>
                        </button>

                        <button 
                            type="button"
                            class="pending-reject-btn"
                            title="Từ chối"
                            onclick="event.stopPropagation(); rejectMember('${rawEmail.replace(/'/g, "\\'")}')"
                            style="
                                display:inline-flex !important;
                                align-items:center !important;
                                justify-content:center !important;
                                width:32px !important;
                                height:32px !important;
                                min-width:32px !important;
                                border:none !important;
                                border-radius:50% !important;
                                background:#e74c3c !important;
                                color:white !important;
                                cursor:pointer !important;
                                padding:0 !important;
                                margin:0 !important;
                                flex:0 0 32px !important;
                            "
                        >
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        pendingSection.style.display = 'none';
        pendingList.innerHTML = '';
    }
}

function renderMemberItem(m) {
    var role = m.role === 'owner' ? 'Chủ kênh' : (m.role === 'admin' ? 'Quản trị' : 'Thành viên');
    var online = m.is_online ? ' online' : '';

    var avatarHtml = m.avatar
        ? `<img src="${m.avatar}" class="member-avatar-img" onerror="this.onerror=null;this.src='';this.nextSibling.style.display='flex';this.style.display='none'" />
           <div class="member-avatar" style="display:none;"><i class="fas fa-user-circle"></i></div>`
        : `<div class="member-avatar"><i class="fas fa-user-circle"></i></div>`;

    var displayName = m.username || m.email || 'User';
    var isMe = normalizeEmail(m.email) === normalizeEmail(getCurrentUserEmail());

    if (isMe) {
        displayName += ' (Bạn)';
    }

    var canKick =
        currentChannel &&
        currentChannel.is_owner &&
        !isMe &&
        m.role !== 'owner' &&
        m.status !== 'pending';

    var kickButtonHtml = '';

    if (canKick) {
        const safeEmailForJs = String(m.email || '').replace(/'/g, "\\'");

        kickButtonHtml = `
            <button
                type="button"
                class="member-kick-btn"
                title="Xóa khỏi kênh"
                onclick="event.stopPropagation(); kickMember('${safeEmailForJs}')"
            >
                <i class="fas fa-user-times"></i>
            </button>
        `;
    }

    return `
        <div class="member-item${online}" data-email="${escapeHtml(m.email || '')}" onclick="viewProfile('${encodeURIComponent(m.email || '')}')">
            ${avatarHtml}

            <div class="member-info">
                <span class="member-name">${escapeHtml(displayName)}</span>
                <span class="member-role">${role}</span>
            </div>

            ${kickButtonHtml}
        </div>
    `;
}
function viewProfile(email) { window.open(`http://localhost:5173/profile/${email}`, '_blank'); }
function approveMember(memberEmail) {
    if (!currentChannel || !currentChannel.is_owner) {
        showToast('Bạn không có quyền phê duyệt thành viên', 'error');
        return;
    }

    apiCall('/channels/' + currentChannel.channel_id + '/approve', 'POST', {
        email: memberEmail,
        approve: true
    })
        .then(() => {
            showToast('Đã chấp nhận yêu cầu tham gia', 'success');
            loadMembers(currentChannel.channel_id);
        })
        .catch(err => {
            showToast('Lỗi chấp nhận yêu cầu: ' + err.message, 'error');
        });
}
function kickMember(memberEmail) {
    if (!currentChannel || !currentChannel.is_owner) {
        showToast('Bạn không có quyền xóa thành viên', 'error');
        return;
    }

    if (normalizeEmail(memberEmail) === normalizeEmail(getCurrentUserEmail())) {
        showToast('Bạn không thể tự xóa chính mình', 'error');
        return;
    }

    if (!confirm(`Bạn có chắc muốn xóa ${memberEmail} khỏi kênh này?`)) {
        return;
    }

    apiCall(
        '/channels/' + currentChannel.channel_id + '/kick/' + encodeURIComponent(memberEmail),
        'POST'
    )
        .then(() => {
            showToast('Đã xóa thành viên khỏi kênh', 'success');

            memberList = memberList.filter(m => normalizeEmail(m.email) !== normalizeEmail(memberEmail));
            renderMembers();

            const memberCountEl = document.getElementById('member-count');
            if (memberCountEl) {
                memberCountEl.innerHTML = '<i class="fas fa-users"></i> <span>' + memberList.length + '</span>';
            }

            loadMembers(currentChannel.channel_id);
        })
        .catch(err => {
            showToast('Lỗi xóa thành viên: ' + err.message, 'error');
        });
}
function rejectMember(memberEmail) {
    if (!currentChannel || !currentChannel.is_owner) {
        showToast('Bạn không có quyền từ chối thành viên', 'error');
        return;
    }

    if (!confirm(`Bạn có chắc muốn từ chối yêu cầu tham gia của ${memberEmail}?`)) {
        return;
    }

    apiCall('/channels/' + currentChannel.channel_id + '/approve', 'POST', {
        email: memberEmail,
        approve: false
    })
        .then(() => {
            showToast('Đã từ chối yêu cầu tham gia', 'success');

            // Xóa ngay khỏi state để UI biến mất lập tức
            memberList = memberList.filter(m => m.email !== memberEmail);

            renderMembers();

            // Đồng bộ lại từ backend
            loadMembers(currentChannel.channel_id);
        })
        .catch(err => {
            showToast('Lỗi từ chối yêu cầu: ' + err.message, 'error');
        });
}

// File Upload
const attachBtn = document.getElementById('btn-attach-file');
const fileInputChannel = document.getElementById('file-input');
if (attachBtn && fileInputChannel) {
    attachBtn.addEventListener('click', () => {
        if (isMutedInCurrentChannel()) {
            showMutedToast();
            return;
        }

        if (attachBtn.disabled || fileInputChannel.disabled) {
            showMutedToast();
            return;
        }

        fileInputChannel.click();
    });

    fileInputChannel.addEventListener('change', async () => {
        if (isMutedInCurrentChannel()) {
            fileInputChannel.value = '';
            showMutedToast();
            return;
        }
        const file = fileInputChannel.files[0];
        if (!file || !currentChatroom || currentChatroom.room_type === 'voice') {
            if (currentChatroom?.room_type === 'voice') showToast('Không thể gửi file trong phòng voice', 'error');
            return;
        }
        const originalHtml = attachBtn.innerHTML;
        attachBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        attachBtn.disabled = true;
        const formData = new FormData();
        formData.append('file', file);
        try {
            const token = getToken();
            const response = await fetch(`${API_URL}/channels/chatrooms/${currentChatroom.room_id}/upload`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });
            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                const errorMsg = extractErrorMessage(errData, 'Upload failed');
                const error = new Error(errorMsg);
                error.status = response.status;
                error.data = errData;
                throw error;
            }
            const data = await response.json();
            aiFileSizeCache[data.file_id] = file.size;
            let msgType = 'file';
            if (file.type.startsWith('image/')) msgType = 'image';
            else if (file.type.startsWith('video/')) msgType = 'video';
            await apiCall(`/channels/chatrooms/${currentChatroom.room_id}/messages`, 'POST', {
                content: data.file_id,
                msg_type: msgType,
                file_id: data.file_id,
                file_name: file.name,
                file_size: file.size
            });
            loadMessages();
            showToast('Đã gửi file', 'success');
        } catch (err) {
            console.error('Upload error:', err);
            const detail = err.data?.detail;

            if (err.status === 403 && detail?.error === 'muted') {
                disableChatInputForMute(
                    detail.reason || detail.message,
                    detail.muted_until
                );

                showMutedToast();
                return;
            }

            if (err.status === 503) {
                showUploadErrorByStatus(
                    503,
                    err.message || 'AI kiểm duyệt đang không khả dụng, vui lòng thử lại sau'
                );
            } else if (err.status === 400) {
                showUploadErrorByStatus(
                    400,
                    err.message || 'File không được phép upload do vi phạm quy tắc kiểm duyệt'
                );
            } else {
                showToast('Lỗi upload: ' + (err.message || 'Upload thất bại'), 'error');
            }
        } finally {
            attachBtn.innerHTML = originalHtml;
            fileInputChannel.value = '';

            if (isMutedInCurrentChannel()) {
                syncMuteControls();
            } else {
                attachBtn.disabled = false;
                attachBtn.classList.remove('disabled');
                attachBtn.title = '';
                attachBtn.style.pointerEvents = '';
                attachBtn.style.opacity = '';
            }
        }
    });
}

async function handleReturnFromMeeting() {
    const urlParams = new URLSearchParams(window.location.search);
    const channelId = urlParams.get('channel');
    const chatroomId = urlParams.get('chatroom');
    const isReturn = urlParams.has('return');

    if (!isReturn || !channelId || !chatroomId) return;

    const url = new URL(window.location);
    url.searchParams.delete('return');
    window.history.replaceState({}, '', url);

    try {
        if (!currentChannel || currentChannel.channel_id !== channelId) {
            await selectChannel(channelId);
            return;
        }

        if (!chatroomList || chatroomList.length === 0) {
            await loadChatrooms(channelId);
        }

        selectChatroom(chatroomId);
    } catch (err) {
        console.error('Handle return from meeting error:', err);
    }
}

// ====== Moderation Rules ======
let currentModerationSettings = {
    enabled: false,
    rules_text: "",
    enabled_types: [],
    action: "warn",
    max_violations: 3,
    penalty_time: null
};

function updateChannelSettingsLabelsForRole(isReadonly) {
    const rulesLabel = document.getElementById('label-moderation-rules');
    const typesLabel = document.getElementById('label-moderation-types');

    if (rulesLabel) {
        rulesLabel.textContent = isReadonly
            ? 'Luật của kênh'
            : 'Luật kiểm duyệt (mỗi dòng một quy tắc, bằng tiếng Việt)';
    }

    if (typesLabel) {
        typesLabel.textContent = isReadonly
            ? 'Áp dụng luật cho:'
            : 'Áp dụng kiểm duyệt cho:';
    }
}

function setChannelSettingsReadonlyMode(isReadonly) {
    const ownerOnlyIds = [
        'input-edit-channel-name',
        'input-edit-channel-desc',
        'input-edit-require-approval',
        'channel-avatar-preview',
        'channel-avatar-placeholder',
        'btn-upload-avatar',
        'btn-remove-avatar',
        'enable-moderation',
        'moderation-action',
        'max-violations',
        'penalty-time',
        'btn-submit-edit-channel',
        'btn-delete-channel'
    ];

    ownerOnlyIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;

        const group = el.closest('.form-group') || el.closest('.channel-avatar-section') || el.parentElement;

        if (group) {
            group.style.display = isReadonly ? 'none' : '';
        } else {
            el.style.display = isReadonly ? 'none' : '';
        }
    });

    const moderationHeader = document.getElementById('moderation-settings-title');
    if (moderationHeader) {
        moderationHeader.style.display = isReadonly ? 'none' : '';
    }

    const moderationRulesHint = document.getElementById('moderation-rules-hint');
    if (moderationRulesHint) {
        moderationRulesHint.style.display = isReadonly ? 'none' : '';
    }

    const submitBtn = document.getElementById('btn-submit-edit-channel');
    const deleteBtn = document.getElementById('btn-delete-channel');

    if (submitBtn) submitBtn.style.display = isReadonly ? 'none' : 'inline-flex';
    if (deleteBtn) deleteBtn.style.display = isReadonly ? 'none' : 'inline-flex';

    const rulesTextarea = document.getElementById('moderation-rules-text');
    if (rulesTextarea) {
        rulesTextarea.disabled = isReadonly;
        rulesTextarea.readOnly = isReadonly;
    }

    const moderateTypes = [
        'moderate-text',
        'moderate-image',
        'moderate-video',
        'moderate-file'
    ];

    moderateTypes.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = isReadonly;
    });

    const modalTitle = document.querySelector('#modal-channel-settings .modal-header h3');
    if (modalTitle) {
        modalTitle.textContent = isReadonly ? 'Thông tin kênh' : 'Cài đặt kênh';
    }
}

async function loadChannelRules() {
    if (!currentChannel) return;
    try {
        const data = await apiCall(`/channels/${currentChannel.channel_id}/rules`);
        currentModerationSettings = data;
        document.getElementById('enable-moderation').checked = data.enabled || false;
        document.getElementById('moderation-rules-container').style.display = data.enabled ? 'block' : 'none';
        document.getElementById('moderation-rules-text').value = data.rules_text || '';
        document.getElementById('moderate-text').checked = data.enabled_types?.includes('text') ?? true;
        document.getElementById('moderate-image').checked = data.enabled_types?.includes('image') ?? false;
        document.getElementById('moderate-video').checked = data.enabled_types?.includes('video') ?? false;
        document.getElementById('moderate-file').checked = data.enabled_types?.includes('file') ?? false;
        document.getElementById('moderation-action').value = data.action || 'warn';
        document.getElementById('max-violations').value = data.max_violations || 3;
        document.getElementById('penalty-time').value = data.penalty_time || 10;
        const penaltyGroup = document.getElementById('penalty-time-group');
        if (penaltyGroup) penaltyGroup.style.display = (data.action === 'mute') ? 'block' : 'none';
    } catch (err) {
        console.error('Failed to load moderation settings:', err);
    }
}

function collectModerationSettings() {
    const enabled = document.getElementById('enable-moderation')?.checked || false;
    const rules_text = document.getElementById('moderation-rules-text')?.value.trim() || '';
    const enabled_types = [];
    if (document.getElementById('moderate-text')?.checked) enabled_types.push('text');
    if (document.getElementById('moderate-image')?.checked) enabled_types.push('image');
    if (document.getElementById('moderate-video')?.checked) enabled_types.push('video');
    if (document.getElementById('moderate-file')?.checked) enabled_types.push('file');
    const action = document.getElementById('moderation-action')?.value || 'warn';
    const max_violations = parseInt(document.getElementById('max-violations')?.value) || 3;
    const penalty_time = action === 'mute' ? (parseInt(document.getElementById('penalty-time')?.value) || 10) : null;
    return { enabled, rules_text, enabled_types, action, max_violations, penalty_time };
}

document.getElementById('enable-moderation')?.addEventListener('change', (e) => {
    document.getElementById('moderation-rules-container').style.display = e.target.checked ? 'block' : 'none';
});

document.getElementById('moderation-action')?.addEventListener('change', (e) => {
    const group = document.getElementById('penalty-time-group');
    if (group) group.style.display = e.target.value === 'mute' ? 'block' : 'none';
});

document.getElementById('btn-submit-edit-channel').addEventListener('click', async function () {
    console.log('Save button clicked');
    const name = document.getElementById('input-edit-channel-name')?.value.trim();
    const description = document.getElementById('input-edit-channel-desc')?.value.trim();
    const requireApproval = document.getElementById('input-edit-require-approval')?.checked || false;
    if (!name) { showToast('Vui lòng nhập tên kênh', 'error'); return; }
    const avatar = currentChannel?.avatar || null;

    let modSettings = {};
    try {
        modSettings = collectModerationSettings();
        console.log('Moderation settings:', modSettings);
    } catch (e) {
        console.error('Error collecting moderation settings:', e);
        showToast('Lỗi thu thập cài đặt kiểm duyệt: ' + e.message, 'error');
        return;
    }

    try {
        const updatedChannel = await apiCall(
            '/channels/' + currentChannel.channel_id,
            'PUT',
            {
                name,
                description,
                require_approval: requireApproval,
                avatar
            }
        );

        await apiCall(
            '/channels/' + currentChannel.channel_id + '/rules',
            'PUT',
            modSettings
        );

        currentChannel = {
            ...currentChannel,
            ...updatedChannel
        };

        channelList = channelList.map(ch =>
            String(ch.channel_id) === String(currentChannel.channel_id)
                ? { ...ch, ...updatedChannel }
                : ch
        );

        await renderChannelDetail();
        renderChannelList();

        showToast('Cập nhật kênh thành công!', 'success');
        document.getElementById('modal-channel-settings').style.display = 'none';
    } catch (err) {
        showToast('Lỗi cập nhật: ' + err.message, 'error');
    }
});

function buildInviteLink(inviteCode) {
    return `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(inviteCode)}`;
}
async function handleInviteLinkJoin() {
    const urlParams = new URLSearchParams(window.location.search);

    const inviteCode = urlParams.get('invite');

    if (!inviteCode) return;

    try {
        const result = await apiCall('/channels/join', 'POST', {
            invite_code: inviteCode
        });

        if (result.status === 'pending') {
            showToast('Đã gửi yêu cầu tham gia kênh, chờ chủ kênh phê duyệt', 'success');
        } else {
            showToast('Tham gia kênh thành công!', 'success');
        }

        urlParams.delete('invite');

        const newQuery = urlParams.toString();
        const newUrl = window.location.pathname + (newQuery ? '?' + newQuery : '');

        window.history.replaceState({}, document.title, newUrl);

        await loadChannels();

        if (result.channel_id && result.status !== 'pending') {
            selectChannel(result.channel_id);
        }

    } catch (err) {
        console.error('Join by invite link error:', err);

        urlParams.delete('invite');

        const newQuery = urlParams.toString();
        const newUrl = window.location.pathname + (newQuery ? '?' + newQuery : '');

        window.history.replaceState({}, document.title, newUrl);

        showToast('Lỗi tham gia kênh qua link mời: ' + err.message, 'error');
    }
}

// ====== Other UI event handlers (create channel, join channel, etc.) ======
document.getElementById('btn-create-channel').addEventListener('click', () => document.getElementById('modal-create-channel').style.display = 'flex');
document.getElementById('btn-submit-create-channel').addEventListener('click', async () => {
    var name = document.getElementById('input-channel-name').value.trim();
    var description = document.getElementById('input-channel-desc').value.trim();
    var requireApproval = document.getElementById('input-require-approval').checked;

    if (!name) {
        showToast('Vui lòng nhập tên kênh', 'error');
        return;
    }

    const submitBtn = document.getElementById('btn-submit-create-channel');
    const originalText = submitBtn.innerText;

    submitBtn.disabled = true;
    submitBtn.innerText = 'Đang tạo...';

    try {
        await apiCall('/channels/create', 'POST', {
            name,
            description,
            require_approval: requireApproval
        });

        showToast('Tạo kênh thành công!', 'success');

        document.getElementById('modal-create-channel').style.display = 'none';
        document.getElementById('input-channel-name').value = '';
        document.getElementById('input-channel-desc').value = '';
        document.getElementById('input-require-approval').checked = false;

        await loadChannels();
    } catch (err) {
        console.error('Create channel error:', err);
        showToast('Lỗi tạo kênh: ' + err.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = originalText;
    }
});
document.getElementById('btn-join-channel').addEventListener('click', () => document.getElementById('modal-join-channel').style.display = 'flex');
document.getElementById('btn-submit-join-channel').addEventListener('click', () => {
    var inviteCode = document.getElementById('input-invite-code').value.trim();
    if (!inviteCode) { showToast('Vui lòng nhập mã mời', 'error'); return; }
    apiCall('/channels/join', 'POST', { invite_code: inviteCode }).then(data => {
        if (data.status === 'pending') showToast('Đã gửi yêu cầu tham gia, chờ phê duyệt', 'success');
        else showToast('Tham gia kênh thành công!', 'success');
        document.getElementById('modal-join-channel').style.display = 'none';
        document.getElementById('input-invite-code').value = '';
        loadChannels();
    }).catch(err => showToast('Lỗi tham gia kênh: ' + err.message, 'error'));
});
document.getElementById('btn-create-chatroom').addEventListener('click', () => document.getElementById('modal-create-chatroom').style.display = 'flex');
document.getElementById('btn-submit-create-chatroom').addEventListener('click', () => {
    var name = document.getElementById('input-chatroom-name').value.trim();
    var description = document.getElementById('input-chatroom-desc').value.trim();
    var type = document.querySelector('input[name="chatroom-type"]:checked').value;
    if (!name) { showToast('Vui lòng nhập tên phòng', 'error'); return; }
    apiCall('/channels/' + currentChannel.channel_id + '/chatrooms', 'POST', { name, description, room_type: type }).then(() => {
        showToast('Tạo phòng chat thành công!', 'success');
        document.getElementById('modal-create-chatroom').style.display = 'none';
        document.getElementById('input-chatroom-name').value = '';
        document.getElementById('input-chatroom-desc').value = '';
        loadChatrooms(currentChannel.channel_id);
    }).catch(err => showToast('Lỗi tạo phòng chat: ' + err.message, 'error'));
});
document.getElementById('btn-channel-settings').addEventListener('click', () => {
    if (!currentChannel) return;

    const isOwner = !!currentChannel.is_owner;
    const isReadonly = !isOwner;

    const nameInput = document.getElementById('input-edit-channel-name');
    const descInput = document.getElementById('input-edit-channel-desc');
    const requireApprovalInput = document.getElementById('input-edit-require-approval');
    const inviteCodeEl = document.getElementById('display-invite-code');

    if (nameInput) nameInput.value = currentChannel.name || '';
    if (descInput) descInput.value = currentChannel.description || '';
    if (requireApprovalInput) requireApprovalInput.checked = currentChannel.require_approval || false;
    if (inviteCodeEl) inviteCodeEl.textContent = currentChannel.invite_code || '-';

    loadChannelAvatarPreview();

    if (typeof loadChannelRules === 'function') {
        loadChannelRules();
    }

    if (typeof setChannelSettingsReadonlyMode === 'function') {
        setChannelSettingsReadonlyMode(isReadonly);
    }

    if (typeof updateChannelSettingsLabelsForRole === 'function') {
        updateChannelSettingsLabelsForRole(isReadonly);
    }

    document.getElementById('modal-channel-settings').style.display = 'flex';
});
document.getElementById('btn-delete-channel').addEventListener('click', () => {
    if (!confirm('Bạn có chắc muốn xóa kênh này?')) return;
    apiCall('/channels/' + currentChannel.channel_id, 'DELETE').then(() => {
        showToast('Đã xóa kênh', 'success');
        document.getElementById('modal-channel-settings').style.display = 'none';
        currentChannel = null; currentChatroom = null;
        document.getElementById('channel-empty').style.display = 'flex';
        document.getElementById('channel-detail').style.display = 'none';
        loadChannels(); stopMemberPolling();
    }).catch(err => showToast('Lỗi xóa kênh: ' + err.message, 'error'));
});
document.getElementById('btn-copy-invite-code').addEventListener('click', () => {
    var code = document.getElementById('display-invite-code').textContent;
    if (code && code !== '-') navigator.clipboard.writeText(code).then(() => showToast('Đã sao chép mã mời!', 'success'));
});
document.getElementById('btn-invite-code').addEventListener('click', () => {
    if (!currentChannel || !currentChannel.invite_code) {
        showToast('Không tìm thấy mã mời của kênh', 'error');
        return;
    }

    const inviteLink = buildInviteLink(currentChannel.invite_code);

    navigator.clipboard.writeText(inviteLink)
        .then(() => {
            showToast('Đã sao chép link mời!', 'success');
        })
        .catch(() => {
            showToast('Không thể sao chép link mời', 'error');
        });
});
document.getElementById('btn-chatroom-settings').addEventListener('click', () => {
    if (!currentChatroom) return;
    document.getElementById('input-edit-chatroom-name').value = currentChatroom.name || '';
    document.getElementById('input-edit-chatroom-desc').value = currentChatroom.description || '';
    document.getElementById('modal-chatroom-settings').style.display = 'flex';
});
document.getElementById('btn-submit-edit-chatroom').addEventListener('click', () => {
    var name = document.getElementById('input-edit-chatroom-name').value.trim();
    var description = document.getElementById('input-edit-chatroom-desc').value.trim();
    if (!name) { showToast('Vui lòng nhập tên phòng', 'error'); return; }
    apiCall('/channels/chatrooms/' + currentChatroom.room_id, 'PUT', { name, description }).then(() => {
        showToast('Cập nhật phòng chat thành công!', 'success');
        document.getElementById('modal-chatroom-settings').style.display = 'none';
        loadChatrooms(currentChannel.channel_id);
        selectChatroom(currentChatroom.room_id);
    }).catch(err => showToast('Lỗi cập nhật phòng chat: ' + err.message, 'error'));
});
document.getElementById('btn-delete-chatroom').addEventListener('click', () => {
    if (!confirm('Bạn có chắc muốn xóa phòng chat này?')) return;
    apiCall('/channels/chatrooms/' + currentChatroom.room_id, 'DELETE').then(() => {
        showToast('Đã xóa phòng chat', 'success');
        document.getElementById('modal-chatroom-settings').style.display = 'none';
        currentChatroom = null;
        document.getElementById('chatroom-empty-inner').style.display = 'flex';
        document.getElementById('chatroom-active').style.display = 'none';
        loadChatrooms(currentChannel.channel_id);
    }).catch(err => showToast('Lỗi xóa phòng chat: ' + err.message, 'error'));
});
document.getElementById('btn-leave-channel').addEventListener('click', function () {
    if (!currentChannel) return;
    if (currentChannel.is_owner) {
        if (!confirm('Bạn là chủ kênh. Bạn có chắc muốn xóa kênh này?')) return;
        apiCall('/channels/' + currentChannel.channel_id, 'DELETE').then(async () => {
            await clearUserSession();
            showToast('Đã xóa kênh', 'success');
            currentChannel = null; currentChatroom = null;
            document.getElementById('channel-empty').style.display = 'flex';
            document.getElementById('channel-detail').style.display = 'none';
            loadChannels(); stopChatroomPolling(); stopMemberPolling();
        }).catch(err => showToast('Lỗi xóa kênh: ' + err.message, 'error'));
    } else {
        if (!confirm('Bạn có chắc muốn rời kênh này?')) return;
        apiCall('/channels/' + currentChannel.channel_id + '/leave', 'POST').then(async () => {
            await clearUserSession();
            showToast('Đã rời kênh', 'success');
            currentChannel = null; currentChatroom = null;
            document.getElementById('channel-empty').style.display = 'flex';
            document.getElementById('channel-detail').style.display = 'none';
            loadChannels(); stopChatroomPolling(); stopMemberPolling();
        }).catch(err => showToast('Lỗi rời kênh: ' + err.message, 'error'));
    }
});

// Send Message
document.getElementById('btn-send-message').addEventListener('click', sendMessage);
document.getElementById('chat-message-input').addEventListener('keypress', function (e) { if (e.key === 'Enter') sendMessage(); });
let cachedFullName = null;
async function getUserFullName() {
    if (cachedFullName) return cachedFullName;
    try {
        const email = getCurrentUserEmail();
        const data = await apiCall(`/account/account_info?email=${email}`);
        cachedFullName = data.fullName || email.split('@')[0];
        return cachedFullName;
    } catch (e) { console.error("Lỗi lấy fullName:", e); const email = getCurrentUserEmail(); cachedFullName = email.split('@')[0]; return cachedFullName; }
}
async function sendMessage() {
    var input = document.getElementById('chat-message-input');

    if (isMutedInCurrentChannel()) {
        syncMuteControls();
        showMutedToast();
        return;
    }

    if (input && input.disabled) {
        syncMuteControls();
        showMutedToast();
        return;
    }

    var content = input.value.trim();

    if (!content || !currentChatroom) return;
    input.value = '';
    const fullName = await getUserFullName();
    const userEmail = getCurrentUserEmail();
    const tempId = 'temp_' + Date.now() + '_' + Math.random();
    const tempMsg = {
        message_id: tempId,
        room_id: currentChatroom.room_id,
        channel_id: currentChannel.channel_id,
        sender_email: userEmail,
        sender_name: fullName,
        content: content,
        msg_type: 'text',
        created_at: new Date().toISOString()
    };
    messageList.push(tempMsg);
    appendNewMessages([tempMsg]);
    try {
        const realMsg = await apiCall(`/channels/chatrooms/${currentChatroom.room_id}/messages`, 'POST', { content: content });
        const index = messageList.findIndex(m => m.message_id === tempId);
        if (index !== -1) {
            messageList[index] = realMsg;
            const msgDiv = document.querySelector(`.message-item[data-temp-id="${tempId}"]`);
            if (msgDiv) {
                msgDiv.setAttribute('data-message-id', realMsg.message_id);
                msgDiv.removeAttribute('data-temp-id');
                const timeSpan = msgDiv.querySelector('.message-time');
                if (timeSpan) timeSpan.textContent = formatTime(realMsg.created_at);
            }
        }
    } catch (err) {
        const index = messageList.findIndex(m => m.message_id === tempId);
        if (index !== -1) {
            messageList.splice(index, 1);
            const msgDiv = document.querySelector(`.message-item[data-temp-id="${tempId}"]`);
            if (msgDiv) msgDiv.remove();
        }
        const detail = err.data?.detail;

        if (err.status === 403 && detail?.error === 'muted') {
            disableChatInputForMute(
                detail.reason || detail.message,
                detail.muted_until
            );

            showMutedToast();
            return;
        }

        showToast('Lỗi gửi tin nhắn: ' + err.message, 'error');
        input.value = content;
    }
}

async function openDocumentAI(fileId, messageId, fileName, fileSize) {
    if (!currentChatroom) return;

    const allowed = await canAnalyzeFileWithUTEZoneAI(
        fileId,
        fileName,
        fileSize
    );

    if (!allowed) return;

    showDocumentAIPanel();
    setDocumentAIView('chat');

    const titleEl = document.getElementById('document-ai-file-name');
    if (titleEl) titleEl.textContent = fileName || 'Tài liệu';

    const messagesEl = document.getElementById('document-ai-messages');
    if (messagesEl) {
        messagesEl.innerHTML = `
            <div class="document-ai-msg assistant">
                <div class="document-ai-bubble">
                    Đang chuẩn bị tài liệu...
                </div>
            </div>
        `;
    }

    try {
        const conversation = await apiCall(
            `/channels/chatrooms/${currentChatroom.room_id}/ai-conversations/from-file`,
            'POST',
            {
                file_id: fileId,
                file_name: fileName,
                message_id: messageId
            }
        );

        await openAIConversation(conversation.conversation_id);

    } catch (err) {
        showToast('Lỗi mở UTEZoneAI: ' + err.message, 'error');
    }
}

function closeDocumentAI() {
    const active = document.getElementById('chatroom-active');
    const panel = document.getElementById('document-ai-panel');

    if (active) active.classList.remove('document-ai-open');
    if (panel) panel.style.display = 'none';

    currentDocumentAI = {
        file_id: null,
        message_id: null,
        file_name: null
    };
}

function renderDocumentAIHistory(messages) {
    const messagesEl = document.getElementById('document-ai-messages');
    if (!messagesEl) return;

    if (!messages || messages.length === 0) {
        messagesEl.innerHTML = `
            <div class="document-ai-msg assistant">
                <div class="document-ai-bubble">
                    Xin chào, mình là UTEZoneAI. Bạn có thể hỏi mình về nội dung tài liệu này.
                </div>
            </div>
        `;
        return;
    }

    messagesEl.innerHTML = messages.map(m => `
        <div class="document-ai-msg ${m.role === 'user' ? 'user' : 'assistant'}">
            <div class="document-ai-bubble">
                ${m.role === 'assistant' ? formatAIAnswer(m.content || '') : escapeHtml(m.content || '')}
            </div>
        </div>
    `).join('');

    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendDocumentAIMessage(role, content) {
    const messagesEl = document.getElementById('document-ai-messages');
    if (!messagesEl) return;

    messagesEl.insertAdjacentHTML('beforeend', `
        <div class="document-ai-msg ${role === 'user' ? 'user' : 'assistant'}">
            <div class="document-ai-bubble">
                ${role === 'assistant' ? formatAIAnswer(content || '') : escapeHtml(content || '')}
            </div>
        </div>
    `);

    messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendDocumentAIQuestion() {
    const input = document.getElementById('document-ai-input');
    const question = input?.value.trim();

    if (!question || !currentAIConversation) return;

    input.value = '';

    appendDocumentAIMessage('user', question);
    appendDocumentAIMessage('assistant', 'Đang suy nghĩ...');

    const messagesEl = document.getElementById('document-ai-messages');
    const lastAssistant = messagesEl?.querySelector('.document-ai-msg.assistant:last-child .document-ai-bubble');

    try {
        const result = await apiCall(
            `/channels/ai-conversations/${currentAIConversation.conversation_id}/ask`,
            'POST',
            {
                question
            }
        );

        if (lastAssistant) {
            lastAssistant.innerHTML = formatAIAnswer(result.answer || 'Không có câu trả lời');
        }

    } catch (err) {
        if (lastAssistant) {
            lastAssistant.textContent = 'Lỗi: ' + err.message;
        }
    }
}

function updateMediaButtonsVisibility() {
    const isVoice = currentChatroom && currentChatroom.room_type === 'voice';

    const mediaGalleryBtn = document.getElementById('btn-media-gallery');
    const filesListBtn = document.getElementById('btn-files-list');
    const searchBtn = document.getElementById('btn-search-messages');
    const roomDocumentAIBtn = document.getElementById('btn-room-document-ai');

    if (mediaGalleryBtn) mediaGalleryBtn.style.display = isVoice ? 'none' : 'inline-flex';
    if (filesListBtn) filesListBtn.style.display = isVoice ? 'none' : 'inline-flex';
    if (searchBtn) searchBtn.style.display = isVoice ? 'none' : 'inline-flex';
    if (roomDocumentAIBtn) roomDocumentAIBtn.style.display = isVoice ? 'none' : 'inline-flex';
}

// Media gallery, files, search listeners
document.getElementById('btn-media-gallery')?.addEventListener('click', async () => {
    if (!currentChatroom) return;
    const modal = document.getElementById('modal-media-files');
    const title = document.getElementById('modal-media-title');
    title.innerText = `Ảnh & Video - ${currentChatroom.name}`;
    modal.style.display = 'flex';
    const contentDiv = document.getElementById('modal-media-content');
    contentDiv.innerHTML = '<div class="loading">Đang tải...</div>';
    try {
        const data = await apiCall(`/channels/chatrooms/${currentChatroom.room_id}/media`);
        const media = data.media || [];
        if (media.length === 0) { contentDiv.innerHTML = '<p>Không có ảnh hoặc video nào.</p>'; return; }
        let html = '<div class="media-grid">';
        for (let item of media) {
            const fileUrl = await getFileUrl(item.file_id);
            if (item.type === 'image') html += `<div class="media-item"><img src="${fileUrl}" onclick="window.open('${fileUrl}')"></div>`;
            else if (item.type === 'video') html += `<div class="media-item"><video src="${fileUrl}" controls style="max-width:100%"></video></div>`;
        }
        html += '</div>';
        contentDiv.innerHTML = html;
    } catch (err) { contentDiv.innerHTML = `<p>Lỗi: ${err.message}</p>`; }
});
document.getElementById('btn-files-list')?.addEventListener('click', async () => {
    if (!currentChatroom) return;
    const modal = document.getElementById('modal-media-files');
    const title = document.getElementById('modal-media-title');
    title.innerText = `Tài liệu - ${currentChatroom.name}`;
    modal.style.display = 'flex';
    const contentDiv = document.getElementById('modal-media-content');
    contentDiv.innerHTML = '<div class="loading">Đang tải...</div>';
    try {
        const data = await apiCall(`/channels/chatrooms/${currentChatroom.room_id}/files`);
        const files = data.files || [];
        if (files.length === 0) { contentDiv.innerHTML = '<p>Không có tài liệu nào.</p>'; return; }
        let html = '<ul class="file-list">';
        for (let item of files) {
            const fileUrl = await getFileUrl(item.file_id);
            html += `
                <li class="file-list-item">
                    <i class="fas fa-file"></i>

                    <button
                        type="button"
                        class="file-jump-link"
                        title="Đi tới tin nhắn chứa file này"
                        onclick="jumpToChatMessage('${escapeJsString(item.message_id)}')">
                        ${escapeHtml(item.file_name)}
                    </button>

                    <a
                        class="file-download-link"
                        href="${fileUrl}"
                        target="_blank"
                        title="Mở hoặc tải file">
                        <i class="fas fa-download"></i>
                    </a>

                    <span class="file-list-meta">
                        - ${escapeHtml(item.sender_name)}
                        (${formatDateTime(item.created_at)})
                    </span>
                </li>
            `;
        }
        html += '</ul>';
        contentDiv.innerHTML = html;
    } catch (err) { contentDiv.innerHTML = `<p>Lỗi: ${err.message}</p>`; }
});
document.getElementById('btn-search-messages')?.addEventListener('click', () => {
    if (!currentChatroom) return;
    const modal = document.getElementById('modal-search');
    modal.style.display = 'flex';
    document.getElementById('search-input').value = '';
    document.getElementById('search-results').innerHTML = '';
});
document.getElementById('btn-do-search')?.addEventListener('click', async () => {
    const keyword = document.getElementById('search-input').value.trim();
    if (!keyword) return;
    const resultsDiv = document.getElementById('search-results');
    resultsDiv.innerHTML = '<div class="loading">Đang tìm...</div>';
    try {
        const data = await apiCall(`/channels/chatrooms/${currentChatroom.room_id}/search?q=${encodeURIComponent(keyword)}`);
        const results = data.results || [];
        if (results.length === 0) { resultsDiv.innerHTML = '<p>Không tìm thấy tin nhắn nào.</p>'; return; }
        let html = '<div class="search-results-list">';
        for (let msg of results) {
            const fileUrl = (msg.msg_type !== 'text' && msg.content) ? await getFileUrl(msg.content) : null;
            let contentHtml = '';
            if (msg.msg_type === 'image' && fileUrl) contentHtml = `<img src="${fileUrl}" style="max-width:100px">`;
            else if (msg.msg_type === 'video' && fileUrl) contentHtml = `<video src="${fileUrl}" controls style="max-width:150px"></video>`;
            else if (msg.msg_type === 'file' && fileUrl) contentHtml = `<a href="${fileUrl}" target="_blank">${escapeHtml(msg.file_name)}</a>`;
            else contentHtml = escapeHtml(msg.content);
            html += `<div class="search-result-item"><div class="search-result-sender">${escapeHtml(msg.sender_name || msg.sender_email)}</div><div class="search-result-content">${contentHtml}</div><div class="search-result-time">${formatTime(msg.created_at)}</div></div>`;
        }
        html += '</div>';
        resultsDiv.innerHTML = html;
    } catch (err) { resultsDiv.innerHTML = `<p>Lỗi: ${err.message}</p>`; }
});

document.getElementById('btn-start-meeting').addEventListener('click', function () {
    if (!currentChatroom) return;
    apiCall('/channels/chatrooms/' + currentChatroom.room_id + '/start-meeting', 'POST').then(data => { location.href = '/room.html?room=' + data.room_id; }).catch(err => showToast('Lỗi tạo phòng họp: ' + err.message, 'error'));
});
document.getElementById('search-channel').addEventListener('input', renderChannelList);
document.querySelectorAll('.modal-close').forEach(btn => { btn.addEventListener('click', function () { var modalId = btn.getAttribute('data-modal'); document.getElementById(modalId).style.display = 'none'; }); });
document.querySelectorAll('.modal-overlay').forEach(overlay => { overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.style.display = 'none'; }); });

document.getElementById('btn-close-document-ai')?.addEventListener('click', closeDocumentAI);

document.getElementById('btn-send-document-ai')?.addEventListener('click', sendDocumentAIQuestion);

document.getElementById('document-ai-input')?.addEventListener('keyup', function (event) {
    if (event.key === 'Enter') {
        sendDocumentAIQuestion();
    }
});

function goBack() { window.history.back(); }

let returningFromMeeting = false;
async function handleUrlSelection() {
    const urlParams = new URLSearchParams(window.location.search);
    const channelId = urlParams.get('channel');
    const chatroomId = urlParams.get('chatroom');

    returningFromMeeting = urlParams.has('return');

    if (!channelId || !chatroomId) return;

    try {
        if (!channelList || channelList.length === 0) {
            await loadChannels();
        }

        const channelExists = channelList.some(ch => ch.channel_id === channelId);

        if (!channelExists) {
            const url = new URL(window.location);
            url.searchParams.delete('channel');
            url.searchParams.delete('chatroom');
            url.searchParams.delete('return');
            window.history.replaceState({}, '', url);
            return;
        }

        await selectChannel(channelId);

        if (!chatroomList || chatroomList.length === 0) {
            await loadChatrooms(channelId);
        }

        selectChatroom(chatroomId);
    } catch (err) {
        console.error('Handle URL selection error:', err);
    }
}

connectUserWebsocket();
loadChannels();
setTimeout(() => {
    handleInviteLinkJoin();
}, 300);
setTimeout(handleUrlSelection, 500);