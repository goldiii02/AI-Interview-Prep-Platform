import io
import json
import os
import re
from typing import Any, Dict, List, Optional, TypedDict

import pdfplumber
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from langchain_groq import ChatGroq
from pydantic import BaseModel, Field

from langgraph.graph import END, StateGraph


# --- Environment ---
load_dotenv()
_HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_HERE, ".env"))

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip().strip('"').strip("'")

if not GROQ_API_KEY:
    raise RuntimeError("Missing GROQ_API_KEY in environment (.env).")


# --- App ---
app = FastAPI(title="AI Interview Prep Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- LLM helpers ---
def _llm(temperature: float = 0.4) -> ChatGroq:
    return ChatGroq(
        model="llama-3.3-70b-versatile",
        groq_api_key=GROQ_API_KEY,
        temperature=temperature,
    )


_JSON_BLOCK_RE = re.compile(r"(\{[\s\S]*\}|\[[\s\S]*\])")


def _parse_json_from_text(text: str) -> Any:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except Exception:
        m = _JSON_BLOCK_RE.search(text)
        if not m:
            raise ValueError("Model did not return JSON.")
        return json.loads(m.group(1))


# --- Schemas ---
class GenerateQuestionsRequest(BaseModel):
    role: str = Field(..., min_length=1)
    skills: List[str] = Field(default_factory=list)


class EvaluateAnswerRequest(BaseModel):
    question: str = Field(..., min_length=1)
    answer: str = Field(..., min_length=1)


class EvaluateAnswerResponse(BaseModel):
    score: int = Field(..., ge=0, le=10)
    gaps: List[str]
    improvements: List[str]
    model_answer: str


# --- Conversational interview schemas ---
class StartInterviewRequest(BaseModel):
    role: str = Field(..., min_length=1)
    skills: List[str] = Field(default_factory=list)


class StartInterviewResponse(BaseModel):
    first_question: str


class ConversationTurn(BaseModel):
    question: str
    answer: str


class NextQuestionRequest(BaseModel):
    previous_question: str = Field(..., min_length=1)
    candidate_answer: str = Field(..., min_length=1)
    role: str = Field(..., min_length=1)
    skills: List[str] = Field(default_factory=list)
    conversation_history: List[ConversationTurn] = Field(default_factory=list)


class NextQuestionResponse(BaseModel):
    feedback: str
    next_question: str
    is_complete: bool


class EndInterviewRequest(BaseModel):
    conversation_history: List[ConversationTurn] = Field(..., min_length=1)


class EndInterviewResponse(BaseModel):
    score: int = Field(..., ge=0, le=10)
    strengths: List[str]
    weaknesses: List[str]
    improvements: List[str]


# --- LangGraph: 4-node evaluation agent ---
class EvalState(TypedDict, total=False):
    question: str
    answer: str
    score: int
    evaluation: str
    gaps: List[str]
    improvements: List[str]
    model_answer: str


def _node_evaluate(state: EvalState) -> EvalState:
    prompt = (
        "You are an interview grader. Evaluate the candidate answer.\n\n"
        "Return STRICT JSON with keys: score (integer 0-10), evaluation (string).\n\n"
        f"Question: {state['question']}\n\n"
        f"Answer: {state['answer']}\n"
    )
    resp = _llm(temperature=0.2).invoke(prompt)
    data = _parse_json_from_text(getattr(resp, "content", str(resp)))
    score = int(data.get("score", 0))
    score = max(0, min(10, score))
    return {"score": score, "evaluation": str(data.get("evaluation", "")).strip()}


def _node_identify_gaps(state: EvalState) -> EvalState:
    prompt = (
        "You are an interview coach. Identify gaps in the answer.\n\n"
        "Return STRICT JSON with key: gaps (array of strings, 2-6 items).\n\n"
        f"Question: {state['question']}\n\n"
        f"Answer: {state['answer']}\n\n"
        f"Evaluation: {state.get('evaluation', '')}\n"
    )
    resp = _llm(temperature=0.3).invoke(prompt)
    data = _parse_json_from_text(getattr(resp, "content", str(resp)))
    gaps = data.get("gaps", [])
    if not isinstance(gaps, list):
        gaps = []
    gaps = [str(x).strip() for x in gaps if str(x).strip()]
    return {"gaps": gaps[:10]}


def _node_suggest_improvements(state: EvalState) -> EvalState:
    prompt = (
        "You are an interview coach. Suggest improvements to the answer.\n\n"
        "Return STRICT JSON with key: improvements (array of strings, 2-6 items).\n\n"
        f"Question: {state['question']}\n\n"
        f"Answer: {state['answer']}\n\n"
        f"Gaps: {json.dumps(state.get('gaps', []))}\n"
    )
    resp = _llm(temperature=0.4).invoke(prompt)
    data = _parse_json_from_text(getattr(resp, "content", str(resp)))
    improvements = data.get("improvements", [])
    if not isinstance(improvements, list):
        improvements = []
    improvements = [str(x).strip() for x in improvements if str(x).strip()]
    return {"improvements": improvements[:10]}


def _node_model_answer(state: EvalState) -> EvalState:
    prompt = (
        "Write an excellent model answer the candidate could give.\n"
        "Keep it concise but complete (6-12 sentences).\n\n"
        f"Question: {state['question']}\n"
    )
    resp = _llm(temperature=0.5).invoke(prompt)
    content = getattr(resp, "content", str(resp))
    return {"model_answer": str(content).strip()}


def _build_eval_graph():
    graph = StateGraph(EvalState)
    graph.add_node("evaluate", _node_evaluate)
    graph.add_node("identify_gaps", _node_identify_gaps)
    graph.add_node("suggest_improvements", _node_suggest_improvements)
    graph.add_node("model_answer", _node_model_answer)

    graph.set_entry_point("evaluate")
    graph.add_edge("evaluate", "identify_gaps")
    graph.add_edge("identify_gaps", "suggest_improvements")
    graph.add_edge("suggest_improvements", "model_answer")
    graph.add_edge("model_answer", END)
    return graph.compile()


_eval_app = _build_eval_graph()


# --- Routes ---
@app.post("/generate-questions")
def generate_questions(
    req: GenerateQuestionsRequest,
) -> List[str]:
    role = req.role.strip()
    skills = [s.strip() for s in req.skills if s.strip()]

    prompt = (
        "You are an expert technical interviewer.\n"
        "Generate exactly 5 high-quality interview questions.\n"
        "Tailor them to the role and skills.\n\n"
        "Return STRICT JSON as an array of 5 strings ONLY.\n\n"
        f"Role: {role}\n"
        f"Skills: {', '.join(skills) if skills else 'N/A'}\n"
    )
    resp = _llm(temperature=0.6).invoke(prompt)
    data = _parse_json_from_text(getattr(resp, "content", str(resp)))
    if not isinstance(data, list):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM returned unexpected format for questions.",
        )
    questions = [str(q).strip() for q in data if str(q).strip()]
    questions = questions[:5]
    if len(questions) != 5:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM did not return exactly 5 questions.",
        )
    return questions


@app.post("/evaluate-answer", response_model=EvaluateAnswerResponse)
def evaluate_answer(
    req: EvaluateAnswerRequest,
) -> EvaluateAnswerResponse:
    state: EvalState = {"question": req.question.strip(), "answer": req.answer.strip()}
    result: EvalState = _eval_app.invoke(state)

    score = int(result.get("score", 0))
    score = max(0, min(10, score))
    gaps = result.get("gaps", []) or []
    improvements = result.get("improvements", []) or []
    model_answer = str(result.get("model_answer", "")).strip()

    return EvaluateAnswerResponse(
        score=score,
        gaps=[str(x) for x in gaps],
        improvements=[str(x) for x in improvements],
        model_answer=model_answer,
    )


# --- Conversational interview endpoints ---
FIRST_QUESTION = (
    "Hello! I'll be your interviewer today. Let's start - Tell me about yourself."
)


@app.post("/start-interview", response_model=StartInterviewResponse)
def start_interview(
    req: StartInterviewRequest,
) -> StartInterviewResponse:
    return StartInterviewResponse(first_question=FIRST_QUESTION)


def _format_history(history: List[ConversationTurn]) -> str:
    if not history:
        return "(none yet)"
    return "\n".join(
        f"Q: {t.question}\nA: {t.answer}" for t in history
    )


@app.post("/next-question", response_model=NextQuestionResponse)
def next_question(req: NextQuestionRequest) -> NextQuestionResponse:
    role = req.role.strip()
    skills = [s.strip() for s in req.skills if s.strip()]
    history = req.conversation_history or []
    full_history = list(history) + [
        ConversationTurn(question=req.previous_question, answer=req.candidate_answer)
    ]
    turn_count = len(full_history)

    prompt = (
        "You are an expert interviewer conducting a real conversational interview "
        "for a fresher candidate.\n\n"
        f"Role: {role}\n"
        f"Candidate skills (from resume): {', '.join(skills) if skills else 'N/A'}\n\n"
        "CONVERSATION SO FAR:\n"
        f"{_format_history(full_history)}\n\n"
        "Your tasks:\n"
        "1. Give BRIEF feedback on the candidate's last answer (1-2 lines only).\n"
        "2. Decide the NEXT question. Rules:\n"
        "   - If the answer mentioned a project, ask a follow-up about that project.\n"
        "   - If the answer was weak or vague, ask a simpler follow-up to help them.\n"
        "   - After 8-10 exchanges total, wrap up with: 'Do you have any questions for us?'\n"
        "   - Otherwise ask the next relevant question.\n"
        "3. After the closing question, set is_complete=true.\n\n"
        f"Current exchange count: {turn_count}. Aim for 8-10 total, then end.\n\n"
        "Return STRICT JSON with exactly these keys:\n"
        '- "feedback": string (1-2 lines on the last answer)\n'
        '- "next_question": string (the next question to ask)\n'
        '- "is_complete": boolean (true only when interview should end)'
    )
    resp = _llm(temperature=0.5).invoke(prompt)
    data = _parse_json_from_text(getattr(resp, "content", str(resp)))
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM returned unexpected format for next question.",
        )
    feedback = str(data.get("feedback", "")).strip() or "Good response."
    next_question_text = str(data.get("next_question", "")).strip()
    if not next_question_text:
        next_question_text = "Do you have any questions for us?"
    is_complete = bool(data.get("is_complete", False))
    return NextQuestionResponse(
        feedback=feedback,
        next_question=next_question_text,
        is_complete=is_complete,
    )


@app.post("/end-interview", response_model=EndInterviewResponse)
def end_interview(req: EndInterviewRequest) -> EndInterviewResponse:
    history_text = _format_history(req.conversation_history)
    prompt = (
        "You are an expert interviewer. The following interview just ended. "
        "Give final feedback.\n\n"
        "CONVERSATION:\n"
        f"{history_text}\n\n"
        "Return STRICT JSON with:\n"
        '- "score": integer 0-10 (overall performance)\n'
        '- "strengths": array of 2-4 short strings\n'
        '- "weaknesses": array of 2-4 short strings (areas to improve)\n'
        '- "improvements": array of 2-4 specific tips (actionable)\n'
    )
    resp = _llm(temperature=0.3).invoke(prompt)
    data = _parse_json_from_text(getattr(resp, "content", str(resp)))
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM returned unexpected format for end interview.",
        )
    score = int(data.get("score", 5))
    score = max(0, min(10, score))
    strengths = data.get("strengths", [])
    weaknesses = data.get("weaknesses", [])
    improvements = data.get("improvements", [])
    if not isinstance(strengths, list):
        strengths = [str(strengths)]
    if not isinstance(weaknesses, list):
        weaknesses = [str(weaknesses)]
    if not isinstance(improvements, list):
        improvements = [str(improvements)]
    return EndInterviewResponse(
        score=score,
        strengths=[str(x).strip() for x in strengths if str(x).strip()][:6],
        weaknesses=[str(x).strip() for x in weaknesses if str(x).strip()][:6],
        improvements=[str(x).strip() for x in improvements if str(x).strip()][:6],
    )


@app.post("/parse-resume")
async def parse_resume(
    file: UploadFile = File(...),
) -> List[str]:
    filename = (file.filename or "").lower()
    if not filename.endswith(".pdf"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only PDF files are supported.",
        )

    content = await file.read()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file.",
        )

    try:
        extracted_parts: List[str] = []
        with pdfplumber.open(io.BytesIO(content)) as pdf:
            for i, page in enumerate(pdf.pages):
                if i >= 15:
                    break
                text = page.extract_text() or ""
                if text.strip():
                    extracted_parts.append(text)
        resume_text = "\n\n".join(extracted_parts).strip()
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to extract text from PDF.",
        ) from e

    if not resume_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No text could be extracted from the PDF (it may be scanned).",
        )

    prompt = (
        "Extract a list of skills from the resume text.\n"
        "Return STRICT JSON as an array of strings only.\n"
        "Include both technical skills (tools, languages, frameworks) and relevant soft skills.\n"
        "Deduplicate and keep each skill short.\n\n"
        f"RESUME TEXT:\n{resume_text}\n"
    )
    resp = _llm(temperature=0.2).invoke(prompt)
    data = _parse_json_from_text(getattr(resp, "content", str(resp)))
    if not isinstance(data, list):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LLM returned unexpected format for skills.",
        )
    skills = [str(s).strip() for s in data if str(s).strip()]
    seen = set()
    skills_unique: List[str] = []
    for s in skills:
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        skills_unique.append(s)

    return skills_unique[:100]
