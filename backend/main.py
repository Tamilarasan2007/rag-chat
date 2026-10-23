import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

from src.vectorstore import FaissVectorStore
from langchain_groq import ChatGroq

app = FastAPI(
    title="RAG Knowledge Assistant API",
    description="A simple FastAPI backend that wraps the existing RAG pipeline.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

vector_store: FaissVectorStore | None = None
llm: ChatGroq | None = None
rag_ready: bool = False
rag_error: str = ""

@app.on_event("startup")
def load_rag_system():
    global vector_store, llm, rag_ready, rag_error

    faiss_index_path = os.path.join(PROJECT_ROOT, "faiss_store", "faiss.index")
    metadata_path    = os.path.join(PROJECT_ROOT, "faiss_store", "metadata.pkl")

    if not os.path.exists(faiss_index_path) or not os.path.exists(metadata_path):
        rag_error = (
            "Vector store not found. "
            "Please run app.py first to build and save the FAISS index."
        )
        print(f"[ERROR] {rag_error}")
        return  e

    try:
        print("[INFO] Loading FAISS vector store from disk...")
        vector_store = FaissVectorStore(
            persist_dir=os.path.join(PROJECT_ROOT, "faiss_store")
        )
        vector_store.load()
        print("[INFO] FAISS store loaded successfully.")
    except Exception as e:
        rag_error = f"Failed to load vector store: {str(e)}"
        print(f"[ERROR] {rag_error}")
        return

    try:
        groq_api_key = os.getenv("GROQ_API_KEY")
        if not groq_api_key:
            rag_error = "GROQ_API_KEY is missing. Add it to your .env file."
            print(f"[ERROR] {rag_error}")
            return

        llm = ChatGroq(
            groq_api_key=groq_api_key,
            model_name="openai/gpt-oss-120b",
        )
        print("[INFO] Groq LLM initialised.")
    except Exception as e:
        rag_error = f"Failed to initialise LLM: {str(e)}"
        print(f"[ERROR] {rag_error}")
        return

    rag_ready = True
    print("[INFO] RAG system is ready.")

class ChatMessage(BaseModel):
    role: str
    content: str


class QuestionRequest(BaseModel):
    question: str
    conversation_id: str | None = None
    history: list[ChatMessage] = []


class AnswerResponse(BaseModel):
    question: str
    answer: str
    sources: list[str] = []
    conversation_id: str | None = None

def is_ambiguous_question(question: str) -> bool:
    """
    Checks if a question is likely a follow-up that relies on conversation context.
    Looks for pronouns, follow-up cues, or very short phrases.
    """
    follow_up_cues = {
        "it", "its", "they", "them", "their", "theirs",
        "this", "that", "these", "those",
        "he", "him", "his", "she", "her",
        "why", "how", "what about", "tell me more",
        "elaborate", "explain further", "continue",
    }
    lower_q = question.lower()
    words = set(lower_q.replace("?", "").replace(".", "").replace(",", "").split())
    if words & follow_up_cues:
        return True
    for phrase in ("what about", "tell me more", "explain further"):
        if phrase in lower_q:
            return True
    return len(words) <= 4


def rewrite_question_if_needed(question: str, history: list[ChatMessage]) -> str:
    """
    Rewrites an ambiguous follow-up question into a standalone question for FAISS search.
    If the question is already self-contained or there is no history, returns it unchanged.
    """
    if not history or not is_ambiguous_question(question):
        return question

    history_lines = [
        f"{'User' if msg.role == 'user' else 'Assistant'}: {msg.content[:250]}"
        for msg in history[-4:]
    ]
    history_text = "\n".join(history_lines)

    prompt = (
        "Given the conversation history and a follow-up question, rewrite the follow-up "
        "question into a standalone question that can be understood without the conversation history.\n"
        "If the question is already fully understandable on its own, return it unchanged.\n"
        "Do not answer the question. Only return the standalone question.\n\n"
        f"Conversation History:\n{history_text}\n\n"
        f"Follow-up Question: {question}\n\n"
        "Standalone Question:"
    )

    try:
        response = llm.invoke(prompt)
        rewritten = response.content.strip().strip('"\'')
        if rewritten:
            print(f"[INFO] Rewrote follow-up question '{question}' -> '{rewritten}'")
            return rewritten
    except Exception as e:
        print(f"[WARNING] Question rewrite failed: {e}")

    return question


@app.get("/api/health")
def health_check():
    """
    Simple health check so the frontend can show 'Connected' or 'Disconnected'.
    Returns whether the backend is running and whether the RAG system is ready.
    """
    return {
        "status": "ok",
        "rag_ready": rag_ready,
        "message": "RAG system is ready." if rag_ready else rag_error,
    }


@app.post("/api/ask", response_model=AnswerResponse)
def ask_question(request: QuestionRequest):
    """
    Main endpoint: takes a question, optional conversation ID, and conversation history,
    then returns an AI-generated answer grounded in retrieved documents.

    Steps:
    1. Validate the question.
    2. Sanitize and bound conversation history from untrusted client.
    3. Rewrite ambiguous follow-up questions for accurate vector search.
    4. Retrieve relevant chunks from FAISS.
    5. Build context and conversation-aware prompt.
    6. Generate and return the answer.
    """

    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")
    if len(question) > 2000:
        raise HTTPException(status_code=400, detail="Question is too long (maximum 2000 characters).")

    if not rag_ready:
        raise HTTPException(
            status_code=503,
            detail=f"RAG system is not ready: {rag_error}",
        )

    clean_history: list[ChatMessage] = []
    for msg in request.history[-6:]:
        if msg.role in ("user", "assistant") and msg.content.strip():
            clean_history.append(
                ChatMessage(
                    role=msg.role,
                    content=msg.content.strip()[:1000],
                )
            )

    try:
        search_query = rewrite_question_if_needed(question, clean_history)
        results = vector_store.query(search_query, top_k=5)

        texts = [
            r["metadata"].get("test") or r["metadata"].get("text", "")
            for r in results
            if r.get("metadata")
        ]
        texts = [t for t in texts if t and t.strip()]
        history_context = ""
        if clean_history:
            history_lines = [
                f"{'User' if m.role == 'user' else 'Assistant'}: {m.content}"
                for m in clean_history
            ]
            history_context = "Conversation History:\n" + "\n".join(history_lines) + "\n\n"

        if not texts:
            prompt = f"""You are a helpful AI assistant.

{history_context}Question: {question}

Answer the question using your general knowledge.
Start your answer with [SOURCE: GENERAL KNOWLEDGE].
Clearly state that the answer is based on general knowledge and was not found in the retrieved document content.
If the question refers to earlier conversation, use the conversation history for context.

Answer:"""

            response = llm.invoke(prompt)

            return AnswerResponse(
                question=question,
                answer=response.content,
                sources=[],
                conversation_id=request.conversation_id,
            )

        context = "\n\n---\n\n".join(texts)
        prompt = f"""You are a helpful AI assistant.

        {history_context}Context from documents:
        {context}

        Question:
        {question}

        Instructions:
    1. Determine whether the provided document context contains enough relevant information to answer the question.
    2. If the context contains enough information:
   -     Answer using the document context.
   -    Start your answer with [SOURCE: DOCUMENT].
    3. If the context does not contain enough information:
   -     Answer using your general knowledge.
-     Start your answer with [SOURCE: GENERAL KNOWLEDGE].
   -     Clearly state that the answer was not found in the retrieved document content.
    4. If the context answers only part of the question:
   -     Answer the supported part using the document.
   -     Clearly identify any additional information from general knowledge.
    5. If the question refers to previous conversation, use the conversation history to understand references.
    6. Do not invent information or fabricate document citations.

    Answer:
    """

        response = llm.invoke(prompt)
        answer = response.content

        sources = [t[:200] + "..." if len(t) > 200 else t for t in texts[:3]]

        return AnswerResponse(
            question=question,
            answer=answer,
            sources=sources,
            conversation_id=request.conversation_id,
        )

    except HTTPException:
        raise
    except Exception as e:
        print(f"[ERROR] Exception during /api/ask: {e}")
        raise HTTPException(
            status_code=500,
            detail="Something went wrong while generating the answer. Check the backend logs.",
        )
