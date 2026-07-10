require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

// 1. 設定 LINE 憑證與管理員 ID
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const ADMIN_USER_ID = process.env.ADMIN_USER_ID; // 你的管理員專屬 ID

// 2. 初始化 LINE Client 與 Express 伺服器
const client = new line.Client(config);
const app = express();

// 3. 建立 Webhook 路由
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook 發生錯誤:', err);
      res.status(500).end();
    });
});

// 4. 處理各種事件的核心邏輯
async function handleEvent(event) {
  
  // ==========================================
  // 功能 A：有人加入群組時，自動 @標記真實名字 並發送群規
  // ==========================================
  if (event.type === 'memberJoined') {
    const joinedUserId = event.joined.members[0].userId;
    let userName = '新成員';

    try {
      if (event.source.type === 'group') {
        const profile = await client.getGroupMemberProfile(event.source.groupId, joinedUserId);
        userName = profile.displayName; 
      }
    } catch (error) {
      console.log('無法抓取新成員名稱');
    }
    
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

    const mentionText = `@${userName}`;
    const replyText = `${mentionText}\n\n${ruleText}`;

    const welcomeMessage = {
      type: 'text',
      text: replyText,
      mentions: {
        mentionees: [{
            index: 0,
            length: mentionText.length,
            type: 'user',
            userId: joinedUserId
        }]
      }
    };

    return client.replyMessage(event.replyToken, welcomeMessage);
  }

  // ==========================================
  // 功能 B：管理員專屬指令 - 標記踢人 (ban @某人)
  // ==========================================
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim().toLowerCase();

    // 檢查訊息是否包含 "ban" 且有 @標記人
    if (text.startsWith('ban') && event.message.mentions && event.message.mentions.mentionees.length > 0) {
      
      // 🚨 安全檢查 1：發送指令的人是設定的管理員嗎？
      if (event.source.userId !== ADMIN_USER_ID) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 警告：你沒有權限使用此指令。'
        });
      }

      // 🚨 安全檢查 2：確保這個指令是在「群組」裡面發送的
      if (event.source.type !== 'group') {
        return Promise.resolve(null);
      }

      const groupId = event.source.groupId;
      const targets = event.message.mentions.mentionees;

      try {
        // 針對所有被 @ 的人執行踢除動作
        for (let target of targets) {
          if (target.type === 'user') {
            await client.kickGroupMember(groupId, target.userId);
          }
        }
        
        // 踢除成功後，回覆群組
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '✅ 已依管理員指令，將該名違規成員請出群組。'
        });

      } catch (error) {
        console.error('踢人失敗:', error);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '❌ 踢除失敗。請確認機器人是否被設定為可以踢人，或者對方是否已經離開群組。'
        });
      }
    }
  }

  // ==========================================
  // 其他事件不處理
  // ==========================================
  return Promise.resolve(null);
}

// 5. 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 機器人伺服器已啟動，正在監聽通訊埠：${PORT}`);
});
