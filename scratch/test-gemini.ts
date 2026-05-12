import { GoogleGenAI } from "@google/genai";
const GENAI_KEY = "AIzaSyDQgiXymgCRAstT1RCELZ_vjopy1qmW9rA";

async function testGemini() {
    const ai = new GoogleGenAI({ apiKey: GENAI_KEY });
    const model = 'gemini-3.1-flash-lite';

    console.log("--- Test Gemini 3.1 con Web Search ---");
    
    try {
        const response = await ai.models.generateContent({
            model: model,
            contents: "Ciao, rispondi con la parola 'OK' se mi senti.",
        });

        console.log("DEBUG - Risposta completa:", JSON.stringify(response, null, 2));
        
        // Verifica come estrarre il testo nel nuovo SDK
        // Nel nuovo SDK (maggio 2026) potrebbe essere response.candidates[0].content.parts[0].text
        // o response.text se è stato aggiunto un getter.
        console.log("\n--- Tentativo estrazione testo ---");
        try {
            console.log("response.text:", (response as any).text);
        } catch (e) {
            console.log("response.text non disponibile");
        }

    } catch (error: any) {
        console.error("Errore durante il test:", error.message);
    }
}

testGemini();
