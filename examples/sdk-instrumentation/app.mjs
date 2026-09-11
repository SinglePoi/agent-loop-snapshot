import OpenAI from 'openai';

export async function runBusiness(baseURL) {
  const client = new OpenAI({ apiKey: 'offline-fixture-key', baseURL });
  const response = await client.chat.completions.create({
    model: 'offline-fixture-model',
    messages: [{ role: 'user', content: 'say hello from the local fixture' }],
  });
  return response.choices[0]?.message.content;
}
