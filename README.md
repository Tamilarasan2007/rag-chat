# RAG Chat

RAG Chat is a small document chatbot I built to learn how retrieval-augmented generation works. You can ask questions about your PDFs, and it retrieves relevant text from the vector store before sending the context to an LLM.

## What it uses

- Python and FastAPI for the backend
- React and Vite for the frontend
- FAISS for vector search
- Sentence Transformers (`all-MiniLM-L6-v2`) for embeddings
- Groq for answer generation

## How it works

1. Load PDF documents and split their text into chunks.
2. Convert the chunks into embeddings and save them in FAISS.
3. When a question comes in, search for relevant chunks.
4. Send the retrieved text and the question to the LLM to generate an answer.

The chat also sends recent conversation messages so follow-up questions can be understood in context. Conversation history is kept in the browser; there is no database for chat history.

## Setup

### 1. Install dependencies

Use the Python environment and dependency files included in the repository. For the frontend:

```bash
cd frontend
npm install
```

Install the Python dependencies using the method you normally use for this project (for example, `uv sync` if you use `uv.lock`).

### 2. Add your API key

Create a `.env` file in the project root and add your Groq API key:

```env
GROQ_API_KEY=your_groq_api_key_here
```

Keep this file private. Do not commit your real API key.

### 3. Build the FAISS index

Put PDFs you are allowed to use in the local `data/` folder, then run:

```bash
python app.py
```

This creates the local vector store in `faiss_store/`. The project does not include personal PDFs or a prebuilt personal index, so you need to build your own.

### 4. Start the backend

From the project root, run:

```bash
uvicorn backend.main:app --reload
```

### 5. Start the frontend

In another terminal:

```bash
cd frontend
npm run dev
```

Open the local address printed by Vite in your browser.

## Notes

- The backend expects the FAISS index and its metadata to exist before it can answer questions.
- Chat history is stored in the browser's `localStorage`, so it does not sync across browsers or devices.
- This is a learning project; answer quality depends on the documents retrieved and the LLM response.
