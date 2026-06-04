import { writeFileSync } from "node:fs";

const outputPath = "supabase/word_pairs.csv";

const seedPairs = `
커피,홍차,음료
도서관,서점,장소
비행기,기차,교통
피자,햄버거,음식
수영장,목욕탕,장소
고양이,강아지,동물
영화관,공연장,문화
초콜릿,사탕,간식
스마트폰,태블릿,기기
바다,호수,자연
라면,우동,음식
축구,농구,운동
우산,비옷,물건
병원,약국,장소
마법사,연금술사,판타지
화산,온천,자연
노래방,콘서트,문화
캠핑,글램핑,여행
눈사람,얼음조각,겨울
택배,퀵서비스,생활
`.trim();

const groups = [
  ["음식", "김밥 유부초밥 떡볶이 순대 라면 우동 칼국수 수제비 냉면 막국수 비빔밥 불고기 갈비찜 삼겹살 보쌈 족발 파스타 리조또 스테이크 피자 햄버거 샌드위치 초밥 라멘 돈가스 짜장면 짬뽕 탕수육 마라탕 딤섬 케이크 초콜릿 아이스크림 쿠키 빙수"],
  ["장소", "도서관 서점 학교 학원 병원 약국 은행 우체국 경찰서 소방서 마트 백화점 시장 편의점 카페 식당 영화관 공연장 미술관 박물관 공원 놀이터 동물원 수족관 공항 기차역 버스터미널 항구 호텔 펜션 리조트 캠핑장 해수욕장 계곡 온천"],
  ["동물", "고양이 강아지 토끼 햄스터 다람쥐 사자 호랑이 표범 치타 늑대 여우 곰 판다 코끼리 하마 기린 말 얼룩말 양 염소 고래 돌고래 상어 가오리 문어 오징어 낙지 해파리 새우 게 나비 벌 개미 잠자리 모기"],
  ["물건", "우산 비옷 가방 백팩 지갑 열쇠 시계 안경 모자 장갑 마스크 수건 칫솔 치약 샴푸 비누 세제 휴지 냄비 프라이팬 주전자 밥솥 전자레인지 오븐 칼 도마 젓가락 숟가락 접시 컵 책상 의자 소파 침대 옷장"],
  ["교통", "자동차 택시 버스 지하철 기차 KTX 비행기 헬리콥터 배 요트 자전거 킥보드 오토바이 스쿠터 트럭 구급차 소방차 경찰차 케이블카 곤돌라"],
  ["전자기기", "스마트폰 태블릿 노트북 데스크톱 모니터 키보드 마우스 이어폰 헤드폰 스피커 마이크 카메라 프린터 공유기 충전기 보조배터리 스마트워치 게임기 드론 프로젝터"],
  ["운동", "축구 농구 야구 배구 탁구 테니스 배드민턴 골프 볼링 당구 수영 다이빙 달리기 마라톤 자전거 스케이트 스키 스노보드 등산 클라이밍"],
  ["취미", "독서 글쓰기 그림그리기 사진촬영 영상편집 악기연주 노래부르기 춤추기 요리 베이킹 뜨개질 목공 도예 퍼즐 보드게임 카드게임 낚시 캠핑 원예 수집"],
  ["자연", "산 언덕 계곡 강 호수 바다 섬 해변 사막 초원 숲 정글 동굴 폭포 온천 화산 빙하 들판 정원 연못"],
  ["날씨계절", "봄 가을 여름 겨울 비 소나기 장마 눈 폭설 우박 안개 서리 바람 돌풍 태풍 폭풍 햇빛 그늘 무더위 한파"],
  ["문화", "영화 드라마 연극 뮤지컬 콘서트 전시회 미술관 박물관 오페라 발레 클래식 재즈 힙합 국악 소설 만화 웹툰 애니메이션"],
  ["직업", "의사 간호사 약사 교사 교수 경찰 소방관 군인 변호사 판사 검사 요리사 제빵사 바리스타 작가 기자 아나운서 배우 가수 개발자"],
  ["감정", "기쁨 행복 설렘 기대 놀람 당황 슬픔 우울 외로움 그리움 화남 짜증 불안 걱정 긴장 초조 피곤 졸림 뿌듯함 감동"],
  ["행동", "걷기 뛰기 앉기 눕기 기다리기 읽기 쓰기 말하기 듣기 보기 찾기 고르기 사기 팔기 빌리기 열기 닫기 켜기 끄기"],
  ["게임", "캐릭터 아바타 레벨 경험치 아이템 장비 무기 방어구 스킬 마법 퀘스트 미션 보스 몬스터 던전 레이드 파티 길드 랭킹 점수"],
  ["보드게임", "주사위 말 카드 토큰 타일 보드판 칩 점수판 룰북 덱 손패 버림패 자원 금화 영토 건물 도로 도시 경매 협상"],
  ["판타지", "마법사 연금술사 기사 용사 왕자 공주 왕 여왕 드래곤 요정 엘프 드워프 오크 마녀 마법봉 검 방패 갑옷 성 던전"],
  ["학교", "국어 문학 수학 영어 과학 물리 화학 생물 역사 지리 사회 경제 미술 음악 체육 시험 숙제 발표 필기 교과서"],
  ["회사", "회의 보고 기획 제안서 발표 자료조사 메일 메신저 일정 마감 출장 외근 재택근무 출근 퇴근 야근 휴가 연차 면접 채용"],
  ["색모양", "빨강 분홍 주황 노랑 연두 초록 민트 하늘색 파랑 남색 보라 자주 갈색 베이지 검정 회색 하양 금색 동그라미 네모"],
  ["시간일정", "아침 점심 저녁 새벽 오전 오후 오늘 내일 어제 주말 평일 월요일 화요일 수요일 목요일 금요일 토요일 일요일 생일 약속"]
];

const seen = new Set();

function addPair(target, villager, wolf, category) {
  if (!villager || !wolf || !category || villager === wolf) return;
  const key = `${villager}\t${wolf}\t${category}`;
  const reverseKey = `${wolf}\t${villager}\t${category}`;
  if (seen.has(key) || seen.has(reverseKey)) return;
  seen.add(key);
  target.push([villager, wolf, category]);
}

const seedRows = [];
for (const line of seedPairs.split("\n")) {
  addPair(seedRows, ...line.split(","));
}

const candidateGroups = [];
for (const [category, text] of groups) {
  const words = text.split(/\s+/).filter(Boolean);
  const candidates = [];
  for (let gap = 1; gap < words.length; gap += 1) {
    for (let index = 0; index + gap < words.length; index += 1) {
      addPair(candidates, words[index], words[index + gap], category);
    }
  }
  candidateGroups.push(candidates);
}

const selectedRows = [...seedRows];
let cursor = 0;
while (selectedRows.length < 1000 && candidateGroups.some((group) => cursor < group.length)) {
  for (const group of candidateGroups) {
    if (selectedRows.length >= 1000) break;
    if (cursor < group.length) selectedRows.push(group[cursor]);
  }
  cursor += 1;
}

if (selectedRows.length !== 1000) {
  throw new Error(`Expected 1000 word pairs, generated ${selectedRows.length}.`);
}

writeFileSync(outputPath, ["villager,wolf,category", ...selectedRows.map((row) => row.join(",")), ""].join("\n"), "utf8");
console.log(
  `Generated ${selectedRows.length} word pairs from ${candidateGroups.reduce((sum, group) => sum + group.length, seedRows.length)} candidates.`
);
