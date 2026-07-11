require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

// 1. 設定 LINE 憑證
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 2. 初始化 LINE Client 與 Express 伺服器
const client = new line.Client(config);
const app = express();

// 🌟 3. 專門給 cron-job 敲門用的喚醒路由 (解決 Output too large 問題)
app.get('/', (req, res) => {
  res.send('OK');
});

// 4. 建立 Webhook 路由 (LINE 伺服器會把訊息推送到這裡)
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook 發生錯誤:', err);
      res.status(500).end();
    });
});

// 5. 處理各種事件的核心邏輯
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
  // 🌟 功能 B：有人離開或被踢出群組時的提示
  // ==========================================
  if (event.type === 'memberLeft') {
    // 確保事件發生在群組中才執行
    if (event.source.type === 'group') {
      const groupId = event.source.groupId;
      const leftMembers = event.left.members;

      try {
        // 針對離開的每一位成員進行播報 (有時可能一次走多人)
        for (let member of leftMembers) {
          let userName = '一位成員';
          
          try {
            // 嘗試抓取離開成員的名字 (若對方封鎖機器人可能會抓不到)
            const profile = await client.getProfile(member.userId);
            userName = profile.displayName;
          } catch (err) {
            console.log('無法取得離開成員的名稱，改用預設稱呼。');
          }

          // 準備離開提示文字
          const leaveMessage = {
            type: 'text',
            text: `👋 ${userName} 離開了群組。`
          };

          // 注意：memberLeft 事件沒有 replyToken，必須用 pushMessage 發送至 groupId
          await client.pushMessage(groupId, leaveMessage);
        }
      } catch (error) {
        console.error('發送離開訊息失敗:', error);
      }
    }
    return Promise.resolve(null);
  }

  // ==========================================
  // 其他事件不處理 (包含一般文字聊天)
  // ==========================================
  return Promise.resolve(null);
}

// 6. 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 機器人伺服器已啟動，正在監聽通訊埠：${PORT}`);
});
