exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const pno = event.queryStringParameters?.pno;
  if (!pno) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required parameter: pno' }) };
  }

  try {
    // Step 1: Fetch the TTAB page server-side (no CORS issues from a server)
    const ttabUrl = `https://ttabvue.uspto.gov/ttabvue/v?pno=${pno}&pty=OPP&eno=1`;
    const pageResp = await fetch(ttabUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    if (!pageResp.ok) {
      throw new Error(`TTAB page returned status ${pageResp.status}`);
    }

    const html = await pageResp.text();

    // Strip HTML tags to get plain text for AI extraction
    const pageText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 8000);

    if (pageText.length < 100) {
      throw new Error('Page returned no usable content — USPTO may be blocking server access');
    }

    // Step 2: Use Gemini to extract the 11 fields
    const prompt = `Extract these fields from the USPTO TTAB page text and return ONLY valid JSON, no markdown, no explanation.

Fields to extract:
- oppositionNumber: The opposition/proceeding number
- clientName: Defendant/Applicant name (the party whose mark is being opposed)
- clientEmail: Defendant email address if listed
- clientAddress: Defendant mailing address if listed
- attorneyName: Defendant attorney name
- attorneyPhone: Defendant attorney phone number
- serialNumber: The trademark application serial number
- mark: The trademark mark text
- opposer: Plaintiff/Opposer name
- opposingCounselName: Plaintiff attorney name
- opposingCounselEmails: Plaintiff attorney email(s)

Use "Not found" for any field not present in the text.

Page text:
${pageText}`;

    const geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 1000 },
        }),
      }
    );

    const geminiData = await geminiResp.json();
    const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(cleaned);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        oppositionNumber: pno,
        data: extracted,
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
