#!/usr/bin/env python3
"""
build_similarity.py

FastText 사전학습 한국어 벡터(cc.ko.300.vec)를 이용하여
사전 내 각 단어에 대한 유사어 매핑 테이블을 생성합니다.

출력: data/similarity_map.json
"""

import json
import os
import sys
from collections import defaultdict

import numpy as np
from gensim.models import KeyedVectors

# 프로젝트 루트 디렉터리
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
WORDS_PATH = os.path.join(DATA_DIR, "words.json")
VEC_PATH = os.path.join(DATA_DIR, "cc.ko.300.vec.gz")
OUTPUT_PATH = os.path.join(DATA_DIR, "similarity_map.json")

# 유사어 상위 N개를 저장
TOP_N = 20


def build_category_fallback(words: list[dict]) -> dict[str, list[str]]:
    """
    의미 카테고리 기반 폴백 매핑을 구축합니다.
    FastText에 없는 단어에 대해, 같은 카테고리 내 다른 단어들을 후보로 합니다.
    """
    category_to_words: dict[str, list[str]] = defaultdict(list)

    for w in words:
        for cat in w.get("categories", []):
            # 대분류만 사용
            top_cat = cat.split(" > ")[0] if " > " in cat else cat
            category_to_words[top_cat].append(w["word_id"])

    return dict(category_to_words)


def main():
    """메인 처리"""
    # 단어 데이터 로드
    print("단어 데이터 로드 중...")
    with open(WORDS_PATH, "r", encoding="utf-8") as f:
        words = json.load(f)

    print(f"총 단어 수: {len(words)}")

    # word_id → word 텍스트 매핑 & word 텍스트 → word_id 리스트 매핑
    id_to_word = {}
    word_text_to_ids: dict[str, list[str]] = defaultdict(list)
    for w in words:
        id_to_word[w["word_id"]] = w["word"]
        word_text_to_ids[w["word"]].append(w["word_id"])

    unique_words = set(id_to_word.values())
    print(f"고유 단어 텍스트 수: {len(unique_words)}")

    # FastText 벡터 로드
    if not os.path.exists(VEC_PATH):
        print(f"오류: {VEC_PATH} 파일을 찾을 수 없습니다.", file=sys.stderr)
        print("먼저 FastText 한국어 벡터를 다운로드하세요:", file=sys.stderr)
        print(
            "  curl -L -o data/cc.ko.300.vec.gz "
            "https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.ko.300.vec.gz",
            file=sys.stderr,
        )
        sys.exit(1)

    print("FastText 벡터 로드 중... (시간이 걸릴 수 있습니다)")
    kv = KeyedVectors.load_word2vec_format(VEC_PATH, binary=False, unicode_errors="ignore")
    print(f"FastText 벡터 로드 완료: {len(kv)} 단어")

    # 사전 내 단어 중 FastText에 있는 것과 없는 것 분류
    in_vocab = set()
    out_of_vocab = set()
    for word_text in unique_words:
        if word_text in kv:
            in_vocab.add(word_text)
        else:
            out_of_vocab.add(word_text)

    print(f"FastText 내 존재: {len(in_vocab)}어")
    print(f"FastText 내 미존재: {len(out_of_vocab)}어")

    # 사전 내 단어만을 대상으로 유사어를 계산
    # 먼저, 사전 내 단어들의 벡터를 미리 추출
    dict_words_in_vocab = sorted(in_vocab)
    print(f"\n유사어 계산 중... (대상: {len(dict_words_in_vocab)}어)")

    # 사전 내 단어들끼리의 유사도를 효율적으로 계산하기 위해
    # 사전 내 단어 벡터 행렬을 생성
    word_list = list(dict_words_in_vocab)
    vectors = np.array([kv[w] for w in word_list])
    # 정규화
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1
    vectors_normalized = vectors / norms

    # 배치 처리로 유사도 계산 (메모리 절약을 위해 청크 단위로)
    similarity_map: dict[str, list[str]] = {}
    chunk_size = 1000
    total_chunks = (len(word_list) + chunk_size - 1) // chunk_size

    for chunk_idx in range(total_chunks):
        start = chunk_idx * chunk_size
        end = min((chunk_idx + 1) * chunk_size, len(word_list))

        # 현재 청크의 유사도 계산
        chunk_vectors = vectors_normalized[start:end]
        similarities = chunk_vectors @ vectors_normalized.T  # (chunk_size, vocab_size)

        for i in range(end - start):
            word_idx = start + i
            word = word_list[word_idx]

            # 자기 자신 제외, 상위 TOP_N개 추출
            sim_scores = similarities[i]
            sim_scores[word_idx] = -1  # 자기 자신 제외

            # 같은 텍스트의 단어도 제외 (동음이의어)
            for j, w in enumerate(word_list):
                if w == word and j != word_idx:
                    sim_scores[j] = -1

            top_indices = np.argsort(sim_scores)[-TOP_N:][::-1]
            similar_words = [word_list[idx] for idx in top_indices if sim_scores[idx] > 0]

            similarity_map[word] = similar_words

        progress = (chunk_idx + 1) / total_chunks * 100
        print(f"  진행: {progress:.1f}% ({end}/{len(word_list)})")

    # 카테고리 기반 폴백 구축
    print("\n카테고리 기반 폴백 구축 중...")
    category_fallback = build_category_fallback(words)

    # OOV 단어에 대해 카테고리 기반으로 유사어 설정
    for w in words:
        word_text = w["word"]
        if word_text not in similarity_map:
            # 카테고리에서 같은 카테고리의 다른 단어를 후보로
            candidates = set()
            for cat in w.get("categories", []):
                top_cat = cat.split(" > ")[0] if " > " in cat else cat
                for cand_id in category_fallback.get(top_cat, []):
                    if cand_id != w["word_id"]:
                        cand_word = id_to_word.get(cand_id, "")
                        if cand_word and cand_word != word_text:
                            candidates.add(cand_word)
                            if len(candidates) >= TOP_N:
                                break
                if len(candidates) >= TOP_N:
                    break
            similarity_map[word_text] = list(candidates)[:TOP_N]

    print(f"유사어 매핑 완료: {len(similarity_map)}어")

    # 매핑이 없는 단어 확인
    no_similar = sum(1 for v in similarity_map.values() if len(v) < 3)
    print(f"유사어 3개 미만인 단어: {no_similar}어")

    # JSON 저장
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(similarity_map, f, ensure_ascii=False)

    file_size = os.path.getsize(OUTPUT_PATH) / 1024 / 1024
    print(f"\n저장 완료: {OUTPUT_PATH}")
    print(f"파일 크기: {file_size:.1f} MB")

    # 샘플 확인
    print("\n=== 유사어 샘플 ===")
    sample_words = ["가게", "사랑", "먹다", "아름답다", "학교"]
    for sw in sample_words:
        if sw in similarity_map:
            print(f"  {sw}: {similarity_map[sw][:5]}")


if __name__ == "__main__":
    main()
