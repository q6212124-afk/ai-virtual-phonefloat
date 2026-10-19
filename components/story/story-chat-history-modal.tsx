"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  ChevronLeft,
  MoreHorizontal,
  Search,
  Plus,
  Send,
  Sparkles,
  Check,
  X,
  MessageSquare,
  Users,
  Compass,
  User,
  Loader2,
} from "lucide-react";
import { Avatar } from "@/components/ui/primitives";
import {
  loadChatSessions,
  loadChatMessages,
  pushChatMessage,
  createOrGetSession,
  type ChatMessage,
  type ChatSession,
} from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateChatCompletion } from "@/lib/chat-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";

export type SelectedChatAttachment = {
  characterId: string;
  characterName: string;
  messages: Array<{
    id: string;
    role: string;
    speakerName: string;
    content: string;
    createdAt: string;
  }>;
};

type StoryChatHistoryModalProps = {
  isOpen: boolean;
  onClose: () => void;
  targetCharacterName: string; // 剧情主控角色的名字，用于弹窗: 确定将此消息展示给{char}?
  onSelectAttachment: (attachment: SelectedChatAttachment) => void;
};

type ViewState = "contacts" | "chat" | "search" | "slice";

export function StoryChatHistoryModal({
  isOpen,
  onClose,
  targetCharacterName,
  onSelectAttachment,
}: StoryChatHistoryModalProps) {
  const [view, setView] = useState<ViewState>("contacts");
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [selectedSession, setSelectedSession] = useState<ChatSession | null>(null);

  // 消息流状态
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [visibleCount, setVisibleCount] = useState<number>(30);
  const [inputText, setInputText] = useState("");
  const [isAiReplying, setIsAiReplying] = useState(false);

  // 下拉菜单
  const [menuOpen, setMenuOpen] = useState(false);

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChatMessage[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  // 上下文切片
  const [sliceMessages, setSliceMessages] = useState<ChatMessage[]>([]);

  // 消息选择模式
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());

  // 二次确认弹窗
  const [confirmDialogVisible, setConfirmDialogVisible] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allCharacters = useMemo(() => loadCharacters(), [isOpen]);
  const currentUserIdentity = useMemo(() => resolveUserIdentity(), []);
  const currentUserName = currentUserIdentity?.name || "我";

  // 获取排序后的联系人列表：按最新消息时间离现在越近排在越上面
  const sortedContacts = useMemo(() => {
    if (!isOpen) return [];
    const sessions = loadChatSessions().filter((s) => !s.isGroup);
    const sessionMap = new Map<string, ChatSession>();
    sessions.forEach((s) => {
      sessionMap.set(s.contactId, s);
    });

    const list = allCharacters.map((char) => {
      const sess = sessionMap.get(char.id);
      let lastTime = 0;
      let lastPreview = "";
      if (sess) {
        lastPreview = sess.lastMessagePreview || "";
        lastTime = sess.updatedAt ? new Date(sess.updatedAt).getTime() : 0;
      }
      return {
        character: char,
        session: sess || null,
        lastTime,
        lastPreview,
      };
    });

    list.sort((a, b) => b.lastTime - a.lastTime);
    return list;
  }, [allCharacters, isOpen]);

  // 重置状态
  useEffect(() => {
    if (isOpen) {
      setView("contacts");
      setSelectedCharacter(null);
      setSelectedSession(null);
      setMessages([]);
      setIsSelectionMode(false);
      setSelectedMessageIds(new Set());
      setConfirmDialogVisible(false);
      setMenuOpen(false);
      setSearchQuery("");
      setSearchResults([]);
      setHasSearched(false);
    }
  }, [isOpen]);

  // 加载所选角色的聊天记录
  const loadMessagesForSession = useCallback((sessId: string) => {
    const msgs = loadChatMessages(sessId);
    setMessages(msgs);
  }, []);

  // 进入指定联系人的聊天页
  const handleOpenContactChat = (char: Character) => {
    const sess = createOrGetSession(char.id);
    setSelectedCharacter(char);
    setSelectedSession(sess);
    setVisibleCount(30);
    loadMessagesForSession(sess.id);
    setIsSelectionMode(false);
    setSelectedMessageIds(new Set());
    setMenuOpen(false);
    setView("chat");
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    }, 50);
  };

  // 向上加载更多
  const handleLoadMore = () => {
    setVisibleCount((prev) => prev + 20);
  };

  // 真实发送消息
  const handleSendMessage = () => {
    if (!inputText.trim() || !selectedSession) return;
    const text = inputText.trim();
    setInputText("");
    const newMsg = pushChatMessage({
      sessionId: selectedSession.id,
      role: "user",
      content: text,
    });
    setMessages((prev) => [...prev, newMsg]);
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  // 真实触发 AI 回复
  const handleAiReply = async () => {
    if (!selectedSession || !selectedCharacter || isAiReplying) return;
    setIsAiReplying(true);
    try {
      const freshMsgs = loadChatMessages(selectedSession.id);
      const res = await generateChatCompletion(selectedSession, freshMsgs);
      const fullText = (res.parts || []).map((p) => p.text).filter(Boolean).join("\n\n");
      if (fullText) {
        const assistantMsg = pushChatMessage({
          sessionId: selectedSession.id,
          role: "assistant",
          content: fullText,
          senderName: selectedCharacter.name,
        });
        setMessages((prev) => [...prev, assistantMsg]);
        setTimeout(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        }, 50);
      }
    } catch (err) {
      console.error("[StoryChatHistoryModal] AI reply failed:", err);
    } finally {
      setIsAiReplying(false);
    }
  };

  // 长按空白处或消息触发选择模式
  const handlePointerDown = (msgId?: string) => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      setIsSelectionMode(true);
      if (msgId) {
        setSelectedMessageIds(new Set([msgId]));
      }
    }, 500);
  };

  const handlePointerUpOrLeave = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const toggleSelectMessage = (msgId: string) => {
    if (!isSelectionMode) return;
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
  };

  // 执行搜索
  const handleSearch = () => {
    const q = searchQuery.trim();
    if (!q || !selectedSession) return;
    const allMsgs = loadChatMessages(selectedSession.id);
    const matched = allMsgs
      .filter((m) => (m.content || "").toLowerCase().includes(q.toLowerCase()))
      .reverse(); // 最新消息在最上面
    setSearchResults(matched);
    setHasSearched(true);
  };

  // 点击某条搜索结果，截取该消息上下各 2 轮消息
  const handleSelectSearchResult = (targetMsg: ChatMessage) => {
    if (!selectedSession) return;
    const allMsgs = loadChatMessages(selectedSession.id);
    const idx = allMsgs.findIndex((m) => m.id === targetMsg.id);
    if (idx === -1) return;

    // 上下两轮：前后各取 4 条消息
    const startIdx = Math.max(0, idx - 4);
    const endIdx = Math.min(allMsgs.length, idx + 5);
    const slice = allMsgs.slice(startIdx, endIdx);

    setSliceMessages(slice);
    setIsSelectionMode(true);
    setSelectedMessageIds(new Set([targetMsg.id]));
    setView("slice");
  };

  // 确认选中的消息并打包为附件
  const handleConfirmAttachment = () => {
    if (!selectedCharacter || selectedMessageIds.size === 0) return;
    const pool = view === "slice" ? sliceMessages : messages;
    const chosen = pool.filter((m) => selectedMessageIds.has(m.id));
    if (chosen.length === 0) return;

    const attachment: SelectedChatAttachment = {
      characterId: selectedCharacter.id,
      characterName: selectedCharacter.name,
      messages: chosen.map((m) => ({
        id: m.id,
        role: m.role,
        speakerName: m.role === "user" ? currentUserName : selectedCharacter.name,
        content: m.content || "",
        createdAt: m.createdAt,
      })),
    };

    onSelectAttachment(attachment);
    setConfirmDialogVisible(false);
    onClose();
  };

  if (!isOpen) return null;

  const currentDisplayMessages = messages.slice(-visibleCount);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 500,
        backgroundColor: "rgba(0, 0, 0, 0.45)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* 仿手机外壳容器 */}
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          height: "100%",
          maxHeight: 740,
          backgroundColor: "#ededed",
          borderRadius: 24,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 40px rgba(0,0,0,0.22)",
          position: "relative",
          userSelect: "none",
        }}
      >
        {/* ===================== VIEW 1: 联系人选择页 ===================== */}
        {view === "contacts" && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
            {/* 顶栏: 退出箭头、微信、加号 */}
            <div
              style={{
                height: 52,
                backgroundColor: "#ededed",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 16px",
                borderBottom: "1px solid rgba(0,0,0,0.06)",
                flexShrink: 0,
              }}
            >
              <button
                onClick={onClose}
                aria-label="退出"
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#181818",
                  padding: 4,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <ChevronLeft size={24} />
              </button>
              <span style={{ fontSize: 17, fontWeight: 600, color: "#181818" }}>微信</span>
              <button
                aria-label="加号"
                style={{
                  background: "none",
                  border: "none",
                  color: "#181818",
                  padding: 4,
                  display: "flex",
                  alignItems: "center",
                  opacity: 0.85,
                }}
              >
                <Plus size={22} />
              </button>
            </div>

            {/* 中间: 联系人列表 (真正可操作的部分) */}
            <div style={{ flex: 1, overflowY: "auto", backgroundColor: "#fff" }}>
              {sortedContacts.length === 0 ? (
                <div style={{ padding: "40px 20px", textAlign: "center", color: "#888", fontSize: 14 }}>
                  暂无联系人
                </div>
              ) : (
                sortedContacts.map(({ character, lastPreview, lastTime }) => (
                  <div
                    key={character.id}
                    onClick={() => handleOpenContactChat(character)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "12px 16px",
                      cursor: "pointer",
                      borderBottom: "1px solid #f2f2f2",
                      transition: "background 150ms",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f7f7f7")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#fff")}
                  >
                    <Avatar src={character.avatar || undefined} name={character.name} size="md" />
                    <div style={{ flex: 1, marginLeft: 12, overflow: "hidden" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 16, fontWeight: 500, color: "#181818" }}>
                          {character.name}
                        </span>
                        {lastTime > 0 && (
                          <span style={{ fontSize: 11, color: "#b2b2b2" }}>
                            {new Date(lastTime).toLocaleDateString([], {
                              month: "numeric",
                              day: "numeric",
                            })}
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          color: "#888",
                          marginTop: 3,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {lastPreview || "暂无最新消息"}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* 底栏: 微信、通讯录、发现、我 (仿图一展示排版) */}
            <div
              style={{
                height: 54,
                backgroundColor: "#f7f7f7",
                borderTop: "1px solid rgba(0,0,0,0.06)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-around",
                flexShrink: 0,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", color: "#07c160" }}>
                <MessageSquare size={20} />
                <span style={{ fontSize: 10, marginTop: 2 }}>微信</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", color: "#999" }}>
                <Users size={20} />
                <span style={{ fontSize: 10, marginTop: 2 }}>通讯录</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", color: "#999" }}>
                <Compass size={20} />
                <span style={{ fontSize: 10, marginTop: 2 }}>发现</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", color: "#999" }}>
                <User size={20} />
                <span style={{ fontSize: 10, marginTop: 2 }}>我</span>
              </div>
            </div>
          </div>
        )}

        {/* ===================== VIEW 2: 真实聊天记录页 ===================== */}
        {view === "chat" && selectedCharacter && selectedSession && (
          <div
            style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}
            onPointerDown={() => handlePointerDown()}
            onPointerUp={handlePointerUpOrLeave}
            onPointerCancel={handlePointerUpOrLeave}
          >
            {/* 顶栏: 返回箭头、{char_name}、… */}
            <div
              style={{
                height: 52,
                backgroundColor: "#ededed",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 16px",
                borderBottom: "1px solid rgba(0,0,0,0.06)",
                position: "relative",
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setView("contacts")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#181818",
                  padding: 4,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <ChevronLeft size={24} />
              </button>
              <span style={{ fontSize: 16, fontWeight: 600, color: "#181818" }}>
                {selectedCharacter.name}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((prev) => !prev);
                }}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#181818",
                  padding: 4,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <MoreHorizontal size={22} />
              </button>

              {/* 以 “…” 为最上栏挂靠的下拉弹窗 */}
              {menuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: 48,
                    right: 12,
                    backgroundColor: "#4c4c4c",
                    color: "#fff",
                    borderRadius: 8,
                    boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
                    zIndex: 60,
                    width: 130,
                    padding: "4px 0",
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setSearchQuery("");
                      setSearchResults([]);
                      setHasSearched(false);
                      setView("search");
                    }}
                    style={{
                      width: "100%",
                      padding: "10px 14px",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "none",
                      border: "none",
                      color: "#fff",
                      fontSize: 14,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <Search size={16} />
                    <span>查找</span>
                  </button>
                </div>
              )}
            </div>

            {/* 消息历史滚动区 */}
            <div
              ref={chatScrollRef}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "14px 12px",
                backgroundColor: "#f5f5f5",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {/* 向上加载更多历史记录 */}
              {messages.length > visibleCount && (
                <div style={{ textAlign: "center", margin: "4px 0" }}>
                  <button
                    onClick={handleLoadMore}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#576b95",
                      fontSize: 12,
                      cursor: "pointer",
                      padding: "4px 8px",
                    }}
                  >
                    加载更早之前的聊天记录
                  </button>
                </div>
              )}

              {currentDisplayMessages.map((msg) => {
                const isUser = msg.role === "user";
                const isSelected = selectedMessageIds.has(msg.id);
                return (
                  <div
                    key={msg.id}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      handlePointerDown(msg.id);
                    }}
                    onPointerUp={handlePointerUpOrLeave}
                    onPointerCancel={handlePointerUpOrLeave}
                    onClick={() => toggleSelectMessage(msg.id)}
                    style={{
                      display: "flex",
                      flexDirection: isUser ? "row-reverse" : "row",
                      alignItems: "flex-start",
                      gap: 8,
                      cursor: isSelectionMode ? "pointer" : "default",
                      position: "relative",
                    }}
                  >
                    {/* 选择模式复选指示器 */}
                    {isSelectionMode && (
                      <div
                        style={{
                          alignSelf: "center",
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          border: isSelected ? "none" : "2px solid #b2b2b2",
                          backgroundColor: isSelected ? "#07c160" : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          flexShrink: 0,
                          margin: "0 4px",
                        }}
                      >
                        {isSelected && <Check size={14} strokeWidth={3} />}
                      </div>
                    )}

                    <Avatar
                      src={isUser ? currentUserIdentity?.avatarUrl : selectedCharacter.avatar || undefined}
                      name={isUser ? currentUserName : selectedCharacter.name}
                      size="sm"
                    />

                    {/* 消息气泡：选中时气泡变灰 */}
                    <div
                      style={{
                        maxWidth: "70%",
                        padding: "9px 12px",
                        borderRadius: 8,
                        fontSize: 14,
                        lineHeight: 1.45,
                        wordBreak: "break-word",
                        backgroundColor: isSelected
                          ? "#a8a8a8"
                          : isUser
                          ? "#95ec69"
                          : "#ffffff",
                        color: isSelected ? "#ffffff" : "#181818",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                        transition: "background-color 150ms ease",
                      }}
                    >
                      {msg.content}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* 底部交互栏 */}
            {isSelectionMode ? (
              /* 选择模式底部动作条: 左边取消，右边选择 */
              <div
                style={{
                  height: 56,
                  backgroundColor: "#f7f7f7",
                  borderTop: "1px solid rgba(0,0,0,0.08)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 20px",
                  flexShrink: 0,
                }}
              >
                <button
                  onClick={() => {
                    setIsSelectionMode(false);
                    setSelectedMessageIds(new Set());
                  }}
                  style={{
                    padding: "8px 24px",
                    borderRadius: 6,
                    border: "1px solid #dcdcdc",
                    backgroundColor: "#fff",
                    color: "#333",
                    fontSize: 14,
                    cursor: "pointer",
                  }}
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    if (selectedMessageIds.size === 0) return;
                    setConfirmDialogVisible(true);
                  }}
                  disabled={selectedMessageIds.size === 0}
                  style={{
                    padding: "8px 24px",
                    borderRadius: 6,
                    border: "none",
                    backgroundColor: selectedMessageIds.size > 0 ? "#07c160" : "#a5e2be",
                    color: "#fff",
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: selectedMessageIds.size > 0 ? "pointer" : "not-allowed",
                  }}
                >
                  选择 ({selectedMessageIds.size})
                </button>
              </div>
            ) : (
              /* 正常交互栏: 胶囊输入框 + AI回复按钮 + 发送按钮 */
              <div
                style={{
                  minHeight: 56,
                  backgroundColor: "#f7f7f7",
                  borderTop: "1px solid rgba(0,0,0,0.08)",
                  display: "flex",
                  alignItems: "center",
                  padding: "8px 12px",
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  placeholder="发送真实消息..."
                  style={{
                    flex: 1,
                    height: 38,
                    borderRadius: 19,
                    border: "1px solid #e0e0e0",
                    padding: "0 14px",
                    fontSize: 14,
                    backgroundColor: "#fff",
                    outline: "none",
                    color: "#181818",
                  }}
                />
                <button
                  onClick={handleAiReply}
                  disabled={isAiReplying}
                  title="让AI角色回复"
                  style={{
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 18,
                    border: "none",
                    backgroundColor: isAiReplying ? "#e8e8e8" : "#e6f7ef",
                    color: isAiReplying ? "#999" : "#07c160",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: isAiReplying ? "not-allowed" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {isAiReplying ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  <span>AI回复</span>
                </button>
                <button
                  onClick={handleSendMessage}
                  disabled={!inputText.trim()}
                  title="发送消息"
                  style={{
                    height: 36,
                    padding: "0 14px",
                    borderRadius: 18,
                    border: "none",
                    backgroundColor: inputText.trim() ? "#07c160" : "#d8d8d8",
                    color: "#fff",
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: inputText.trim() ? "pointer" : "not-allowed",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Send size={13} />
                  <span>发送</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* ===================== VIEW 3: 查找页面 ===================== */}
        {view === "search" && selectedCharacter && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
            {/* 顶栏: 返回箭头、查找 */}
            <div
              style={{
                height: 52,
                backgroundColor: "#ededed",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 16px",
                borderBottom: "1px solid rgba(0,0,0,0.06)",
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setView("chat")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#181818",
                  padding: 4,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <ChevronLeft size={24} />
              </button>
              <span style={{ fontSize: 16, fontWeight: 600, color: "#181818" }}>查找</span>
              <div style={{ width: 28 }} />
            </div>

            {/* 搜索框 (长方形胶囊状) */}
            <div style={{ padding: "12px 16px", backgroundColor: "#ededed", flexShrink: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  backgroundColor: "#fff",
                  borderRadius: 20,
                  padding: "0 14px",
                  height: 38,
                  border: "1px solid #ddd",
                }}
              >
                <Search size={16} color="#888" style={{ marginRight: 8 }} />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSearch();
                    }
                  }}
                  placeholder="搜索聊天记录关键词并回车..."
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    fontSize: 14,
                    color: "#181818",
                    backgroundColor: "transparent",
                  }}
                />
                {searchQuery && (
                  <button
                    onClick={() => {
                      setSearchQuery("");
                      setSearchResults([]);
                      setHasSearched(false);
                    }}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "#999" }}
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
            </div>

            {/* 搜索结果列表: 一条消息占一栏，最新消息在最上面 */}
            <div style={{ flex: 1, overflowY: "auto", backgroundColor: "#fff" }}>
              {hasSearched && searchResults.length === 0 ? (
                <div style={{ padding: "40px 20px", textAlign: "center", color: "#888", fontSize: 14 }}>
                  未找到包含“{searchQuery}”的消息记录
                </div>
              ) : (
                searchResults.map((msg) => {
                  const isUser = msg.role === "user";
                  const speaker = isUser ? currentUserName : selectedCharacter.name;
                  return (
                    <div
                      key={msg.id}
                      onClick={() => handleSelectSearchResult(msg)}
                      style={{
                        padding: "12px 16px",
                        borderBottom: "1px solid #f2f2f2",
                        cursor: "pointer",
                        transition: "background-color 150ms",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f7f7f7")}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#fff")}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>{speaker}</span>
                        <span style={{ fontSize: 11, color: "#999" }}>
                          {new Date(msg.createdAt).toLocaleString([], {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          color: "#555",
                          lineHeight: 1.4,
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {msg.content}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ===================== VIEW 4: 指定消息切片选择页 ===================== */}
        {view === "slice" && selectedCharacter && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
            {/* 顶栏: 返回箭头、{char_name} (切片) */}
            <div
              style={{
                height: 52,
                backgroundColor: "#ededed",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 16px",
                borderBottom: "1px solid rgba(0,0,0,0.06)",
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setView("search")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#181818",
                  padding: 4,
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <ChevronLeft size={24} />
              </button>
              <span style={{ fontSize: 16, fontWeight: 600, color: "#181818" }}>
                {selectedCharacter.name} (聊天切片)
              </span>
              <div style={{ width: 28 }} />
            </div>

            {/* 切片气泡区 */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "14px 12px",
                backgroundColor: "#f5f5f5",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ textAlign: "center", color: "#999", fontSize: 11, margin: "4px 0" }}>
                已调取该消息上下两轮历史切片，点击可勾选消息
              </div>
              {sliceMessages.map((msg) => {
                const isUser = msg.role === "user";
                const isSelected = selectedMessageIds.has(msg.id);
                return (
                  <div
                    key={msg.id}
                    onClick={() => toggleSelectMessage(msg.id)}
                    style={{
                      display: "flex",
                      flexDirection: isUser ? "row-reverse" : "row",
                      alignItems: "flex-start",
                      gap: 8,
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        alignSelf: "center",
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        border: isSelected ? "none" : "2px solid #b2b2b2",
                        backgroundColor: isSelected ? "#07c160" : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        flexShrink: 0,
                        margin: "0 4px",
                      }}
                    >
                      {isSelected && <Check size={14} strokeWidth={3} />}
                    </div>

                    <Avatar
                      src={isUser ? currentUserIdentity?.avatarUrl : selectedCharacter.avatar || undefined}
                      name={isUser ? currentUserName : selectedCharacter.name}
                      size="sm"
                    />

                    <div
                      style={{
                        maxWidth: "70%",
                        padding: "9px 12px",
                        borderRadius: 8,
                        fontSize: 14,
                        lineHeight: 1.45,
                        wordBreak: "break-word",
                        backgroundColor: isSelected
                          ? "#a8a8a8"
                          : isUser
                          ? "#95ec69"
                          : "#ffffff",
                        color: isSelected ? "#ffffff" : "#181818",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                      }}
                    >
                      {msg.content}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 切片页底部动作条: 左取消，右选择 */}
            <div
              style={{
                height: 56,
                backgroundColor: "#f7f7f7",
                borderTop: "1px solid rgba(0,0,0,0.08)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 20px",
                flexShrink: 0,
              }}
            >
              <button
                onClick={() => setView("search")}
                style={{
                  padding: "8px 24px",
                  borderRadius: 6,
                  border: "1px solid #dcdcdc",
                  backgroundColor: "#fff",
                  color: "#333",
                  fontSize: 14,
                  cursor: "pointer",
                }}
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (selectedMessageIds.size === 0) return;
                  setConfirmDialogVisible(true);
                }}
                disabled={selectedMessageIds.size === 0}
                style={{
                  padding: "8px 24px",
                  borderRadius: 6,
                  border: "none",
                  backgroundColor: selectedMessageIds.size > 0 ? "#07c160" : "#a5e2be",
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: selectedMessageIds.size > 0 ? "pointer" : "not-allowed",
                }}
              >
                选择 ({selectedMessageIds.size})
              </button>
            </div>
          </div>
        )}

        {/* ===================== 二次确认弹窗 ===================== */}
        {/* 弹窗内容模板: 确定将此消息展示给{char}? 下面两选项: 左边“取消”右边“确定” */}
        {confirmDialogVisible && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "rgba(0,0,0,0.4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 100,
            }}
          >
            <div
              style={{
                width: 270,
                backgroundColor: "#fff",
                borderRadius: 14,
                overflow: "hidden",
                boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
                textAlign: "center",
              }}
            >
              <div style={{ padding: "24px 18px", fontSize: 16, fontWeight: 500, color: "#181818", lineHeight: 1.4 }}>
                确定将此消息展示给{targetCharacterName}?
              </div>
              <div
                style={{
                  display: "flex",
                  borderTop: "1px solid #e5e5e5",
                  height: 48,
                }}
              >
                <button
                  onClick={() => setConfirmDialogVisible(false)}
                  style={{
                    flex: 1,
                    background: "none",
                    border: "none",
                    borderRight: "1px solid #e5e5e5",
                    fontSize: 16,
                    color: "#555",
                    cursor: "pointer",
                  }}
                >
                  取消
                </button>
                <button
                  onClick={handleConfirmAttachment}
                  style={{
                    flex: 1,
                    background: "none",
                    border: "none",
                    fontSize: 16,
                    fontWeight: 600,
                    color: "#576b95",
                    cursor: "pointer",
                  }}
                >
                  确定
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
