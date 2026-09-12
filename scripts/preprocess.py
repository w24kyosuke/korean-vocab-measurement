#!/usr/bin/env python3
"""
preprocess.py

국립국어원 한국어기초사전 JSON 데이터에서 퀴즈 대상 단어를 추출하여
통일된 형식의 data/words.json을 생성합니다.

대상 품사: 명사, 동사, 형용사
제외 품사: 접사, 어미, 조사, 부사, 관형사, 감탄사, 보조 동사 등
"""

import json
import glob
import os
import sys

# 프로젝트 루트 디렉터리
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, "1216884")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, "data")

# 대상 품사
TARGET_POS = {"명사", "동사", "형용사"}


def classify_word_type(org_language: str) -> str:
    """
    org_language 필드를 분석하여 어종을 분류합니다.

    - org_language 없음 → 고유어
    - CJK 한자만 포함 → 한자어
    - 라틴 문자만 포함 (한자 없음) → 외래어
    - 한자 + 라틴 혼합 → 혼종어
    """
    if not org_language or not org_language.strip():
        return "고유어"

    has_cjk = any(0x4E00 <= ord(c) <= 0x9FFF for c in org_language)
    has_latin = any(c.isascii() and c.isalpha() for c in org_language)

    if has_cjk and has_latin:
        return "혼종어"
    elif has_cjk:
        return "한자어"
    elif has_latin:
        return "외래어"
    else:
        return "고유어"


def extract_words_from_file(filepath: str) -> list[dict]:
    """
    하나의 JSON 파일에서 퀴즈 대상 단어를 추출합니다.
    """
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    items = data.get("channel", {}).get("item", [])
    words = []

    for item in items:
        word_info = item.get("wordInfo", {})
        sense_info = item.get("senseInfo", {})

        # 품사 필터링
        pos = word_info.get("sp_code_name", "")
        if pos not in TARGET_POS:
            continue

        # 기본 정보
        word = word_info.get("org_word", "").strip()
        if not word:
            continue

        word_id = word_info.get("word_no", "")
        sup_no = word_info.get("sup_no", "0")
        level = word_info.get("im_cnt", "없음")
        org_language = word_info.get("org_language", "")
        word_type = classify_word_type(org_language)
        gubun = word_info.get("gubun", "")

        # 의미 카테고리 추출
        categories = []
        for cat in word_info.get("senseCategoryList", []):
            sc = cat.get("semanticCategory", "")
            if sc:
                categories.append(sc)

        # 주제/장면 추출
        topics = []
        for act in word_info.get("actCategoryList", []):
            topic = act.get("subjectCategiory", "")
            if topic:
                topics.append(topic)

        # 뜻풀이 추출
        sense_data_list = sense_info.get("senseDataList", [])
        definitions = []
        for sense in sense_data_list:
            definition = sense.get("definition", "").strip()
            if definition:
                definitions.append(definition)

        # 뜻풀이가 없는 단어는 제외
        if not definitions:
            continue

        # 단어 하이픈 처리 (접두사 '가-' → '가', 접미사 '-가' → '가' 등은 이미 제외됨)
        # 하지만 일반 단어에 하이픈이 있는 경우도 있으므로 그대로 유지

        words.append(
            {
                "word_id": f"{word_id}_{sup_no}",
                "word": word,
                "pos": pos,
                "level": level,
                "word_type": word_type,
                "definitions": definitions,
                "categories": categories,
                "topics": topics,
            }
        )

    return words


def main():
    """메인 처리"""
    # JSON 파일 목록
    json_files = sorted(glob.glob(os.path.join(DATA_DIR, "*.json")))
    if not json_files:
        print(f"오류: {DATA_DIR} 에서 JSON 파일을 찾을 수 없습니다.", file=sys.stderr)
        sys.exit(1)

    print(f"처리할 파일: {len(json_files)}개")

    # 전체 단어 추출
    all_words = []
    for filepath in json_files:
        filename = os.path.basename(filepath)
        words = extract_words_from_file(filepath)
        all_words.extend(words)
        print(f"  {filename}: {len(words)}어 추출")

    print(f"\n총 추출 단어: {len(all_words)}어")

    # 통계 출력
    pos_stats = {}
    level_stats = {}
    type_stats = {}
    topic_count = 0

    for w in all_words:
        pos_stats[w["pos"]] = pos_stats.get(w["pos"], 0) + 1
        level_stats[w["level"]] = level_stats.get(w["level"], 0) + 1
        type_stats[w["word_type"]] = type_stats.get(w["word_type"], 0) + 1
        if w["topics"]:
            topic_count += 1

    print(f"\n품사별: {pos_stats}")
    print(f"난이도별: {level_stats}")
    print(f"어종별: {type_stats}")
    print(f"주제/장면 있는 단어: {topic_count}어")

    # 출력 디렉터리 생성
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # JSON 저장
    output_path = os.path.join(OUTPUT_DIR, "words.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(all_words, f, ensure_ascii=False, indent=2)

    print(f"\n저장 완료: {output_path}")
    print(f"파일 크기: {os.path.getsize(output_path) / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
