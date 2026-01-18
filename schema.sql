DROP TABLE IF EXISTS users;
CREATE TABLE users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    is_verified INTEGER DEFAULT 0,
    language TEXT,
    is_blocked INTEGER DEFAULT 0,
    blocked_at TEXT,
    created_at INTEGER
);

DROP TABLE IF EXISTS messages;
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_message_id INTEGER,
    user_id INTEGER,
    guest_message_id INTEGER,
    created_at INTEGER
);

CREATE INDEX idx_messages_admin_msg_id ON messages(admin_message_id);
