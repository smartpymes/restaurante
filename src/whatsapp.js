import axios from 'axios';
const token = process.env.WHATSAPP_TOKEN;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

export function handleVerify(req, res) {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const verify_token = req.query['hub.verify_token'];
  if (mode && verify_token && mode === 'subscribe' && verify_token === process.env.WHATSAPP_VERIFY_TOKEN) { return res.status(200).send(challenge); }
  return res.sendStatus(403);
}

export async function sendText(to, text) {
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;
  await axios.post(url, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }, { headers: { Authorization: `Bearer ${token}` } });
}