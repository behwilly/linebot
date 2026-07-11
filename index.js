require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const mysql = require('mysql2/promise');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS 
  ? process.env.ADMIN_USER_IDS.split(',').map(id => id.trim()).filter(id => id !== '') 
  : [];

const client = new line.Client(config);
const app = express();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.get('/', (req, res) => {
  res.send('OK');
});

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook 系統重大錯誤:', err);
      res.status(500).end();
    });
});

// ==========================================
// 🌟 升級版小幫手：從資料庫撈取真實名字來標記
// ==========================================
async function addAdminTags(baseText, existingMentionees = []) {
  if (ADMIN_USER_IDS.length === 0) {
    return { text: baseText, mentionees: existingMentionees };
  }
  
  let text = baseText + '\n\n⚠️ 通知管理員：\n';
  let mentionees = [...existingMentionees];
  
  const adminsToTag = ADMIN_USER_IDS.slice(0, 15);
  
  for (let adminId of adminsToTag) {
    let adminName = '管理員'; // 預設名稱
    
    try {
      // 去資料庫找這位管理員的真實名字
      const [rows] = await pool.query('SELECT display_name FROM users WHERE user_id = ?', [adminId]);
      if (rows.length > 0) {
        adminName = rows[0].display_name;
      }
    } catch (error) {
      console.error('[DB 錯誤] 查詢管理員名稱失敗');
    }
    
    const tag = `@${adminName}`;
    mentionees.push({
      index: text.length,
      length: tag.length,
      type: 'user',
      userId: adminId
    });
    text += tag + ' '; // 加上標記跟一個空白
  }
  
  return { text, mentionees };
}

async function handleEvent(event) {
  
  if (event.type === 'message') {
    const senderId = event.source.userId;
    const groupId = event.source.groupId;

    // 同步寫入 users 資料表
    if (event.source.type === 'group' && senderId) {
      try {
        const profile = await client.getGroupMemberProfile(groupId, senderId);
        const currentName = profile.displayName;

        await pool.query(
          'INSERT INTO users (user_id, display_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE display_name = ?',
          [senderId, currentName, currentName]
        );
      } catch (error) {}
    }

    if (event.message.type === 'text') {
      const originalText = event.message.text.trim();
      const text = originalText.toLowerCase();

      // 指令 1：查詢 ID
      if (text === '!我的id' || text === '！我的id') {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `你的專屬 User ID 是：\n${senderId}\n\n請將這串代碼交給總管理員設定權限。`
        });
      }

      // 指令 2：加入黑名單
      if (text.startsWith('ban') && event.message.mention && event.message.mention.mentionees.length > 0) {
        if (!ADMIN_USER_IDS.includes(senderId)) {
          return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 警告：你沒有權限設定黑名單。' });
        }

        const targets = event.message.mention.mentionees;
        let bannedNames = [];

        for (let target of targets) {
          if (target.type === 'user') {
            const targetId = target.userId;
            let targetName = '該成員';
            
            try {
              const [rows] = await pool.query('SELECT display_name FROM users WHERE user_id = ?', [targetId]);
              if (rows.length > 0) targetName = rows[0].display_name;
              else {
                try {
                  const p = await client.getGroupMemberProfile(groupId, targetId);
                  targetName = p.displayName;
                } catch (e) { targetName = '未知成員'; }
              }
              
              await pool.query('INSERT IGNORE INTO blacklist (user_id, display_name) VALUES (?, ?)', [targetId, targetName]);
              bannedNames.push(targetName);
            } catch (err) { console.error('[DB 錯誤] 寫入 blacklist 失敗:', err.message); }
          }
        }

        if (bannedNames.length > 0) {
          const baseText = `✅ 已將 ${bannedNames.join(', ')} 記錄至資料庫黑名單！\n下次此人若再加入群組，系統會立刻發出警報。`;
          // 🌟 等待非同步的小幫手撈取真實名字
          const result = await addAdminTags(baseText);

          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: result.text,
            mentions: { mentionees: result.mentionees }
          });
        }
      }

      // 指令 3：解除黑名單
      if (text.startsWith('unban ')) {
        if (!ADMIN_USER_IDS.includes(senderId)) {
          return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 警告：你沒有權限解除黑名單。' });
        }

        const targetId = originalText.substring(6).trim();
        if (!targetId) return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ 請在 unban 後面輸入完整的 User ID！' });

        try {
          const [rows] = await pool.query('SELECT display_name FROM blacklist WHERE user_id = ?', [targetId]);
          
          if (rows.length > 0) {
            const targetName = rows[0].display_name;
            await pool.query('DELETE FROM blacklist WHERE user_id = ?', [targetId]);
            
            return client.replyMessage(event.replyToken, {
              type: 'text',
              text: `✅ 已將 [${targetName}] 從黑名單中移除！\n他們現在可以安全加入群組了。`
            });
          } else {
            return client.replyMessage(event.replyToken, { type: 'text', text: `⚠️ 找不到此 ID，該成員原本就不在黑名單中喔！` });
          }
        } catch (err) { return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 系統發生錯誤。' }); }
      }

      // 指令 4：查看黑名單
      if (text === '!黑名單' || text === '！黑名單') {
        if (!ADMIN_USER_IDS.includes(senderId)) {
          return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 警告：你沒有權限查看黑名單。' });
        }

        try {
          const [rows] = await pool.query('SELECT user_id, display_name, DATE_FORMAT(banned_at, "%Y-%m-%d %H:%i") as ban_time FROM blacklist ORDER BY banned_at DESC');
          
          if (rows.length === 0) return client.replyMessage(event.replyToken, { type: 'text', text: '✨ 報告：目前黑名單是空的，群組非常和平！' });

          let listText = '📜 【買賣群黑名單列表】 📜\n\n';
          rows.forEach((row, index) => {
            listText += `${index + 1}. ${row.display_name}\nID: ${row.user_id}\n時間: ${row.ban_time}\n\n`;
          });
          listText += '(若要解除，請複製上方 ID 並輸入：\nunban 加上ID)';

          return client.replyMessage(event.replyToken, { type: 'text', text: listText.trim() });
        } catch (err) { return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 讀取黑名單失敗。' }); }
      }
    }
  }

  // ==========================================
  // 功能：有人加入群組時 (警報或歡迎)
  // ==========================================
  if (event.type === 'memberJoined') {
    const joinedUserId = event.joined.members[0].userId;
    let userName = '新成員';
    const groupId = event.source.groupId;

    try {
      if (event.source.type === 'group') {
        const profile = await client.getGroupMemberProfile(groupId, joinedUserId);
        userName = profile.displayName; 
        
        await pool.query(
          'INSERT INTO users (user_id, display_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE display_name = ?',
          [joinedUserId, userName, userName]
        );
      }
    } catch (error) {}

    const mentionText = `@${userName}`;

    try {
      const [rows] = await pool.query('SELECT * FROM blacklist WHERE user_id = ?', [joinedUserId]);
      
      if (rows.length > 0) {
        const baseWarningText = `🚨 【黑名單硬闖警報】🚨\n\n${mentionText} \n此人曾經被管理員列入黑名單，請立即評估是否將其請出群組！`;
        const initialMention = [{ index: 15, length: mentionText.length, type: 'user', userId: joinedUserId }];
        
        // 🌟 等待非同步的小幫手撈取真實名字
        const result = await addAdminTags(baseWarningText, initialMention);
        
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: result.text,
          mentions: { mentionees: result.mentionees }
        });
      }
    } catch (error) { console.error('[DB 錯誤] 查詢黑名單失敗', error); }

    const ruleText = `買賣群新規定
1:進買賣群需要通過版主及管理員，不得擅自邀請及踢人

2:物件、返豆、現刷凡是交易，請勿PO出價錢（價錢不公開）若要便宜出，可打上：甜價或者豬肉價

3:為保障大家帳戶安全，代售著也需要負起連帶責任，介紹的請注意。

4:為妥善管理人員記事本留言處需簽到，管理員會審核，所以不要亂放！

5.若惡意棄單，遭人提供截圖檢舉，確認屬實，進行踢出！所以下單時請先想好再購買！

6:如代客收物件返豆，客人無法立即匯款，一律收取訂金視同交易成功，客人若反悔或已經有收到（訂金不退款）契約精神

7:非重大事件情節請勿欸特所有人，尤其是半夜

創新群，一切照規定走！
若犯不會寬待，請大家配合🙏🏻`;

    const replyText = `${mentionText}\n\n${ruleText}`;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: replyText,
      mentions: { mentionees: [{ index: 0, length: mentionText.length, type: 'user', userId: joinedUserId }] }
    });
  }

  // ==========================================
  // 功能：有人離開群組時 (報名字)
  // ==========================================
  if (event.type === 'memberLeft') {
    if (event.source.type === 'group') {
      const groupId = event.source.groupId;
      const leftMembers = event.left.members;

      try {
        for (let member of leftMembers) {
          let userName = '一位成員';
          
          const [rows] = await pool.query('SELECT display_name FROM users WHERE user_id = ?', [member.userId]);
          if (rows.length > 0) {
            userName = rows[0].display_name;
          }

          await client.pushMessage(groupId, {
            type: 'text',
            text: `👋 ${userName} 離開了群組。`
          });
          
          await pool.query('DELETE FROM users WHERE user_id = ?', [member.userId]);
        }
      } catch (error) { }
    }
    return Promise.resolve(null);
  }

  return Promise.resolve(null);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 機器人伺服器已啟動，正在監聽通訊埠：${PORT}`);
});
