require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const mysql = require('mysql2/promise');

// 1. 設定 LINE 憑證
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 取得管理員 ID 名單 (在 Render 後台設定 ADMIN_USER_IDS，多個人用逗號隔開)
const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS.split(',') : [];

const client = new line.Client(config);
const app = express();

// 2. 建立 MySQL 連線池 (Connection Pool)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 專門給 cron-job 敲門用的喚醒路由 (解決 Output too large 問題)
app.get('/', (req, res) => {
  res.send('OK');
});

// 3. 建立 Webhook 路由
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook 系統重大錯誤:', err);
      res.status(500).end();
    });
});

// 4. 處理各種事件的核心邏輯
async function handleEvent(event) {
  
  // ==========================================
  // 功能 A：接收訊息事件 (包含：同步寫入 users、查ID、設定黑名單)
  // ==========================================
  if (event.type === 'message') {
    const senderId = event.source.userId;
    const groupId = event.source.groupId;

    // 🌟 核心修正：只要有人在「群組」裡發言 (不限文字、貼圖、照片)，就觸發寫入/更新 users 資料表
    if (event.source.type === 'group' && senderId) {
      try {
        const profile = await client.getGroupMemberProfile(groupId, senderId);
        const currentName = profile.displayName;

        // 寫入 MySQL，如果該用戶已存在就更新他的名字 (避免改名抓不到)
        await pool.query(
          'INSERT INTO users (user_id, display_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE display_name = ?',
          [senderId, currentName, currentName]
        );
        console.log(`[DB 記錄成功] 已同步用戶數據: ${currentName} (${senderId})`);
      } catch (error) {
        // 如果連線失敗或資料表不存在，會在 Render Logs 印出詳細原因
        console.error('[DB 錯誤] 嘗試寫入 users 資料表失敗，原因:', error.message);
      }
    }

    // 當訊息類型是「文字」時，才處理指令
    if (event.message.type === 'text') {
      const text = event.message.text.trim().toLowerCase();

      // 指令 1：查詢自己的 ID
      if (text === '!我的id' || text === '！我的id') {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `你的專屬 User ID 是：\n${senderId}\n\n請將這串代碼交給總管理員設定權限。`
        });
      }

      // 指令 2：管理員專屬指令 - 將違規者加入 MySQL 黑名單 (ban @某人)
      // 🌟 關鍵修正：拼字由 event.message.mentions 改為官方正確的 mention (沒有 s)
      if (text.startsWith('ban') && event.message.mention && event.message.mention.mentionees.length > 0) {
        
        // 安全檢查：確認發言人是否為管理員
        if (!ADMIN_USER_IDS.includes(senderId)) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '❌ 警告：你不在管理員名單中，沒有權限設定黑名單。'
          });
        }

        const targets = event.message.mention.mentionees;
        let bannedNames = [];

        for (let target of targets) {
          if (target.type === 'user') {
            const targetId = target.userId;
            let targetName = '該成員';
            
            try {
              // 先從本地 users 表撈取該用戶之前發言存下的名字
              const [rows] = await pool.query('SELECT display_name FROM users WHERE user_id = ?', [targetId]);
              if (rows.length > 0) {
                targetName = rows[0].display_name;
              } else {
                // 如果 users 表沒有，嘗試直接跟 LINE 伺服器要名字
                try {
                  const p = await client.getGroupMemberProfile(groupId, targetId);
                  targetName = p.displayName;
                } catch (e) {
                  targetName = '未知成員';
                }
              }
              
              // 寫入 MySQL 的 blacklist 資料表
              await pool.query('INSERT IGNORE INTO blacklist (user_id, display_name) VALUES (?, ?)', [targetId, targetName]);
              bannedNames.push(targetName);
            } catch (err) {
              console.error('[DB 錯誤] 寫入 blacklist 黑名單失敗，原因:', err.message);
            }
          }
        }

        if (bannedNames.length > 0) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `✅ 已將 ${bannedNames.join(', ')} 記錄至資料庫黑名單！\n下次此人若再加入群組，系統會立刻發出警報。`
          });
        }
      }
    }
  }

  // ==========================================
  // 功能 B：有人加入群組時 (查詢資料庫黑名單 或 正常歡迎)
  // ==========================================
  if (event.type === 'memberJoined') {
    const joinedUserId = event.joined.members[0].userId;
    let userName = '新成員';
    const groupId = event.source.groupId;

    try {
      if (event.source.type === 'group') {
        const profile = await client.getGroupMemberProfile(groupId, joinedUserId);
        userName = profile.displayName; 
        
        // 新人進群，順便寫入 users 資料表備份名字
        await pool.query(
          'INSERT INTO users (user_id, display_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE display_name = ?',
          [joinedUserId, userName, userName]
        );
      }
    } catch (error) {
      console.error('[LINE/DB 錯誤] 處理新成員入群資料快取失敗:', error.message);
    }

    const mentionText = `@${userName}`;

    try {
      // 🚨 去 MySQL 檢查：這個人是不是在黑名單裡面？
      const [rows] = await pool.query('SELECT * FROM blacklist WHERE user_id = ?', [joinedUserId]);
      
      if (rows.length > 0) {
        // 在黑名單內！觸發警報
        const warningText = `🚨 【黑名單警報】🚨\n\n${mentionText} \n此人曾經被管理員列入黑名單，請版主與管理員注意，並評估是否將其請出群組！`;
        
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: warningText,
          mentions: {
            mentionees: [{ index: 15, length: mentionText.length, type: 'user', userId: joinedUserId }]
          }
        });
      }
    } catch (error) {
      console.error('[DB 錯誤] 查詢黑名單失敗，原因:', error.message);
    }

    // 若不在黑名單，就發送正常的群規歡迎詞
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
      mentions: {
        mentionees: [{ index: 0, length: mentionText.length, type: 'user', userId: joinedUserId }]
      }
    });
  }

  // ==========================================
  // 功能 C：有人離開群組時的提示 (從資料庫撈名字)
  // ==========================================
  if (event.type === 'memberLeft') {
    if (event.source.type === 'group') {
      const groupId = event.source.groupId;
      const leftMembers = event.left.members;

      try {
        for (let member of leftMembers) {
          let userName = '一位成員';
          
          // 從 MySQL 查詢他叫什麼名字
          const [rows] = await pool.query('SELECT display_name FROM users WHERE user_id = ?', [member.userId]);
          if (rows.length > 0) {
            userName = rows[0].display_name;
          }

          await client.pushMessage(groupId, {
            type: 'text',
            text: `👋 ${userName} 離開了群組。`
          });
          
          // 人離開後，從 users 暫存表刪除以節省空間
          await pool.query('DELETE FROM users WHERE user_id = ?', [member.userId]);
        }
      } catch (error) {
        console.error('[DB/LINE 錯誤] 處理成員離開事件失敗，原因:', error.message);
      }
    }
    return Promise.resolve(null);
  }

  return Promise.resolve(null);
}

// 5. 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 機器人伺服器已啟動，正在監聽通訊埠：${PORT}`);
});
