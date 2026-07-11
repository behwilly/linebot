require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const mysql = require('mysql2/promise'); // 🌟 引入 MySQL 套件

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const ADMIN_USER_IDS = process.env.ADMIN_USER_IDS ? process.env.ADMIN_USER_IDS.split(',') : [];

const client = new line.Client(config);
const app = express();

// 🌟 建立 MySQL 連線池 (Connection Pool)
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
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
      console.error('Webhook 發生錯誤:', err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  
  // ==========================================
  // 功能 A & B：文字訊息處理 (記名字、查ID、加黑名單)
  // ==========================================
  if (event.type === 'message' && event.source.type === 'group') {
    const text = event.message.type === 'text' ? event.message.text.trim().toLowerCase() : '';
    const senderId = event.source.userId;
    const groupId = event.source.groupId;
    
    // 🌟 隱藏功能：只要有人發言，就把他的名字寫入 MySQL users 表
    try {
      const profile = await client.getGroupMemberProfile(groupId, senderId);
      // 使用 ON DUPLICATE KEY UPDATE，如果人已經在裡面就更新名字
      await pool.query(
        'INSERT INTO users (user_id, display_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE display_name = ?',
        [senderId, profile.displayName, profile.displayName]
      );
    } catch (error) {
      // 抓不到名字就算了
    }

    // 🌟 管理員專屬指令 1：查詢自己的 ID
    if (text === '!我的id' || text === '！我的id') {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `你的專屬 User ID 是：\n${senderId}\n\n請將這串代碼交給總管理員設定權限。`
      });
    }

    // 🌟 管理員專屬指令 2：將違規者加入 MySQL 黑名單 (ban @某人)
    if (text.startsWith('ban') && event.message.mentions && event.message.mentions.mentionees.length > 0) {
      
      if (!ADMIN_USER_IDS.includes(senderId)) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 警告：你不在管理員名單中，沒有權限設定黑名單。'
        });
      }

      const targets = event.message.mentions.mentionees;
      let bannedNames = [];

      for (let target of targets) {
        if (target.type === 'user') {
          const targetId = target.userId;
          let targetName = '該成員';
          
          try {
            // 先去資料庫查他原本叫什麼名字
            const [rows] = await pool.query('SELECT display_name FROM users WHERE user_id = ?', [targetId]);
            if (rows.length > 0) {
              targetName = rows[0].display_name;
            }
            
            // 寫入 MySQL 的 blacklist 表 (用 INSERT IGNORE 避免重複加入報錯)
            await pool.query('INSERT IGNORE INTO blacklist (user_id, display_name) VALUES (?, ?)', [targetId, targetName]);
            bannedNames.push(targetName);
          } catch (err) {
            console.error('寫入黑名單資料庫失敗', err);
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

  // ==========================================
  // 功能 C：有人加入群組時 (查詢資料庫黑名單 或 正常歡迎)
  // ==========================================
  if (event.type === 'memberJoined') {
    const joinedUserId = event.joined.members[0].userId;
    let userName = '新成員';

    try {
      if (event.source.type === 'group') {
        const profile = await client.getGroupMemberProfile(event.source.groupId, joinedUserId);
        userName = profile.displayName; 
        
        // 寫入 MySQL users 表
        await pool.query(
          'INSERT INTO users (user_id, display_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE display_name = ?',
          [joinedUserId, userName, userName]
        );
      }
    } catch (error) {
      console.log('無法抓取新成員名稱');
    }

    const mentionText = `@${userName}`;

    try {
      // 🚨 去 MySQL 檢查：這個人是不是在黑名單裡面？
      const [rows] = await pool.query('SELECT * FROM blacklist WHERE user_id = ?', [joinedUserId]);
      
      if (rows.length > 0) {
        // 在黑名單內！發送警報
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
      console.error('查詢黑名單失敗', error);
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
  // 功能 D：有人離開群組時的提示 (從資料庫撈名字)
  // ==========================================
  if (event.type === 'memberLeft') {
    if (event.source.type === 'group') {
      const groupId = event.source.groupId;
      const leftMembers = event.left.members;

      try {
        for (let member of leftMembers) {
          let userName = '一位成員';
          
          // 🌟 從 MySQL 查詢他叫什麼名字
          const [rows] = await pool.query('SELECT display_name FROM users WHERE user_id = ?', [member.userId]);
          if (rows.length > 0) {
            userName = rows[0].display_name;
          }

          await client.pushMessage(groupId, {
            type: 'text',
            text: `👋 ${userName} 離開了群組。`
          });
          
          // 人離開後，從 users 暫存表刪除以節省空間 (黑名單表絕對不會刪)
          await pool.query('DELETE FROM users WHERE user_id = ?', [member.userId]);
        }
      } catch (error) {
        console.error('資料庫操作或發送離開訊息失敗:', error);
      }
    }
    return Promise.resolve(null);
  }

  return Promise.resolve(null);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 機器人伺服器已啟動，正在監聽通訊埠：${PORT}`);
});
