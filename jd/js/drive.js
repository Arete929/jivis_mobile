// 파일명: drive.js (지비스 모바일용) | @version 1.0.0
// 사진·영상 첨부는 아직 폰에서 못 한다(PC 웹앱에서). 웹앱 화면이 오류 글을 그대로 보여 준다.
export async function uploadFile() { throw new Error('폰에서는 사진·영상 첨부를 아직 못 합니다 — PC 의 체육수업진도 웹앱에서 올려 주세요'); }
export async function ensureFolder() { throw new Error('폰에서는 쓰지 않습니다'); }
