require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const { google } = require('googleapis');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function tabloyaEkle(tarih, gonderen, alet, marka, model, aciklama, fotografLink) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'A:G',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[tarih, gonderen, alet, marka, model, aciklama, fotografLink]]
    }
  });
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body || '';
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  console.log('Mesaj geldi:', from, body, mediaUrl);

  try {
    let reply = '';

    if (mediaUrl && mediaType && mediaType.startsWith('image/')) {
      const authHeader = 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64');
      
      const imageResponse = await fetch(mediaUrl, {
        headers: { 'Authorization': authHeader }
      });
      
      const contentType = imageResponse.headers.get('content-type') || mediaType;
      const imageBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      console.log('Fotograf boyutu:', imageBuffer.byteLength, 'bytes');
      console.log('Content type:', contentType);

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Image
              }
            },
            {
              type: 'text',
              text: `Bu fotoğraftaki aleti veya test cihazını tanımla. 
              Cevabını şu formatta ver:
              ALET: (alet adı)
              MARKA: (marka adı, bilinmiyorsa "Bilinmiyor")
              MODEL: (model adı, bilinmiyorsa "Bilinmiyor")
              AÇIKLAMA: (ne işe yarar, 1-2 cümle)
              Eğer fotoğrafta alet yoksa sadece "ALET DEĞİL" yaz.`
            }
          ]
        }]
      });

      const cevap = response.content[0].text;
      console.log('Claude cevabi:', cevap);

      if (cevap.includes('ALET DEĞİL')) {
        reply = '❌ Fotoğrafta alet veya cihaz tespit edemedim. Lütfen tekrar çekin.';
      } else {
        const alet = (cevap.match(/ALET:\s*(.+)/) || [])[1] || 'Bilinmiyor';
        const marka = (cevap.match(/MARKA:\s*(.+)/) || [])[1] || 'Bilinmiyor';
        const model = (cevap.match(/MODEL:\s*(.+)/) || [])[1] || 'Bilinmiyor';
        const aciklama = (cevap.match(/AÇIKLAMA:\s*(.+)/) || [])[1] || '';
        const tarih = new Date().toLocaleString('tr-TR');

        await tabloyaEkle(tarih, from, alet, marka, model, aciklama, mediaUrl);

        reply = `✅ Alet tanındı ve stoka eklendi!\n\n🔧 *${alet}*\n🏷️ Marka: ${marka}\n📋 Model: ${model}\n📝 ${aciklama}`;
      }
    } else {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: body }]
      });
      reply = response.content[0].text;
    }

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: reply
    });

    res.status(200).send('OK');
  } catch (error) {
    console.error('Hata:', error);
    res.status(500).send('Hata olustu');
  }
});

app.get('/', (req, res) => {
  res.send('WP Bot çalışıyor! 🤖');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Bot ${PORT} portunda çalışıyor`);
});
