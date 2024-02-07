const express = require("express");
const http = require("http");

const app = express();
const httpServer = http.createServer(app);

const { Server } = require("socket.io");

require("dotenv").config();

// 1. Import Dependencies
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
const { OpenAIEmbeddings } = require("langchain/embeddings/openai");
const { MemoryVectorStore } = require("langchain/vectorstores/memory");
const { BraveSearch } = require("langchain/tools");
const OpenAI = require("openai");
const cheerio = require("cheerio");
const { log } = require("console");

// 2. Initialize OpenAI and Supabase clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const embeddings = new OpenAIEmbeddings();

async function rephraseInput(inputString) {
  const gptAnswer = await openai.chat.completions.create({
    model: "gpt-3.5-turbo-0125",
    messages: [
      {
        role: "system",
        content:
          "You are a rephraser and always respond with a rephrased version of the input that is given to a search engine API. Always be succint and use the same words as the input.",
      },
      { role: "user", content: inputString },
    ],
  });
  return gptAnswer.choices[0].message.content;
}

async function searchEngineForSources(messageData) {
  const { message } = messageData;
  console.log("HELLO");
  const loader = new BraveSearch({ apiKey: process.env.BRAVE_SEARCH_API_KEY });
  console.log("HELLO2");
  const repahrasedMessage = await rephraseInput(message);
  console.log("HELLO3");
  const docs = await loader.call(repahrasedMessage);
  console.log("HELLO4");

  function normalizeData(docs) {
    return JSON.parse(docs)
      .filter((doc) => doc.title && doc.link && !doc.link.includes("brave.com"))
      .slice(0, 4)
      .map(({ title, link }) => ({ title, link }));
  }
  const normalizedData = normalizeData(docs);
  return normalizedData;
}

async function processVectors(normalizedData) {
  // 8. Initialize vectorCount
  let vectorCount = 0;
  // 9. Initialize async function for processing each search result item
  const fetchAndProcess = async (item) => {
    try {
      // 10. Create a timer for the fetch promise
      const timer = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), 1500)
      );
      // 11. Fetch the content of the page
      const fetchPromise = fetchPageContent(item.link);
      // 12. Wait for either the fetch promise or the timer
      const htmlContent = await Promise.race([timer, fetchPromise]);
      // 13. Check for insufficient content length
      if (htmlContent.length < 250) return null;
      // 14. Split the text into chunks
      const splitText = await new RecursiveCharacterTextSplitter({
        chunkSize: 200,
        chunkOverlap: 0,
      }).splitText(htmlContent);
      // 15. Create a vector store from the split text
      const vectorStore = await MemoryVectorStore.fromTexts(
        splitText,
        { annotationPosition: item.link },
        embeddings
      );
      // 16. Increment the vector count
      vectorCount++;
      // 17. Perform similarity search on the vectors
      return await vectorStore.similaritySearch(message, 1);
    } catch (error) {
      // 18. Log any error and increment the vector count
      console.log(`Failed to fetch content for ${item.link}, skipping!`);
      vectorCount++;
      return null;
    }
  };
  // 19. Wait for all fetch and process promises to complete
  const results = await Promise.all(normalizedData.map(fetchAndProcess));
  // 20. Make sure that vectorCount reaches at least 4
  return { results: results, vectorCount: vectorCount };
}

async function fetchPageContent(link) {
  const response = await fetch(link);
  return extractMainContent(await response.text());
}

function extractMainContent(html) {
  const $ = cheerio.load(html);
  $("script, style, head, nav, footer, iframe, img").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

async function triggerLLMAndFollowup(inputString) {
  // 28. Call getGPTResults with inputString

  // 29. Generate follow-up with generateFollowup
  const followUpResult = await generateFollowup(inputString);
  // 30. Send follow-up payload

  // 31. Return JSON response
  return { type: "FollowUp", content: followUpResult };
}

async function generateFollowup(message) {
  // 52. Create chat completion with OpenAI API
  const chatCompletion = await openai.chat.completions.create({
    messages: [
      {
        role: "system",
        content: `You are a follow up answer generator and always respond with 4 follow up questions based on this input "${message}" in JSON format. i.e. { "follow_up": ["QUESTION_GOES_HERE", "QUESTION_GOES_HERE", "QUESTION_GOES_HERE"] }`,
      },
      {
        role: "user",
        content: `Generate a 4 follow up questions based on this input ""${message}"" `,
      },
    ],
    model: "gpt-3.5-turbo-0125",
  });
  // 53. Return the content of the chat completion
  return chatCompletion.choices[0].message.content;
}

const getGPTResults = async (inputString, socket) => {
  // 33. Initialize accumulatedContent
  //   let accumulatedContent = "";
  // 34. Open a streaming connection with OpenAI
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo-0125",
    messages: [
      {
        role: "system",
        content:
          "You are a answer generator, you will receive top results of similarity search, they are optional to use depending how well they help answer the query.",
      },
      { role: "user", content: inputString },
    ],
    stream: true,
  });

  let accumulatedContent = "";

  for await (const part of response) {
    // 38. Check if delta content exists
    if (part.choices[0]?.delta?.content) {
      // 39. Accumulate the content
      accumulatedContent += part.choices[0]?.delta?.content;
    }
  }
  socket.emit("emit-payload", { type: "GPT", content: accumulatedContent });
  // 35. Create an initial row in the database
  //   let rowId = await createRowForGPTResponse(to);
  //   // 36. Send initial payload
  //   sendPayload({ type: "Heading", content: "Answer", to: to });
  //   // 37. Iterate through the response stream
  //   for await (const part of stream) {
  //     // 38. Check if delta content exists
  //     if (part.choices[0]?.delta?.content) {
  //       // 39. Accumulate the content
  //       accumulatedContent += part.choices[0]?.delta?.content;
  //       // 40. Update the row with new content
  //       rowId = await updateRowWithGPTResponse(rowId, accumulatedContent, to);
  //     }
  //   }
};

const io = new Server(httpServer, {
  cors: {
    origin: "https://rag-app-eight.vercel.app/",
  },
});

io.on("connection", (socket) => {
  socket.on("send-message", async (messageData) => {
    const normalizedDocs = await searchEngineForSources(messageData);

    socket.emit("emit-payload", { type: "Sources", content: normalizedDocs });

    let { results, vectorCount } = await processVectors(normalizedDocs);

    while (vectorCount < 4) {
      vectorCount++;
    }
    // 21. Filter out unsuccessful results
    const successfulResults = results.filter((result) => result !== null);
    // 22. Get top 4 results if there are more than 4, otherwise get all
    const topResult =
      successfulResults.length > 4
        ? successfulResults.slice(0, 4)
        : successfulResults;
    // 23. Send a payload message indicating the vector creation process is complete
    socket.emit("emit-payload", {
      type: "VectorCreation",
      content: `Finished Scanning Sources.`,
    });
    // 24. Trigger any remaining logic and follow-up actions
    const inputString = `Query: ${
      messageData.message
    }, Top Results: ${JSON.stringify(topResult)}`;
    socket.emit("emit-payload", { type: "Heading", content: "Answer" });
    await getGPTResults(inputString, socket);

    const followUpPayload = await triggerLLMAndFollowup(inputString);
    socket.emit("emit-payload", followUpPayload);
    console.log(followUpPayload);
  });
});

app.get("/", (req, res) => {
  res.send("hello");
});

httpServer.listen(process.env.PORT || 3005, () => {});
