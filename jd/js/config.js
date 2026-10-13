// 파일명: config.js | @version 1.0.0
// 파이어베이스 콘솔에서 받은 설정값. 공개되어도 되는 값이며,
// 실제 보안은 firestore.rules(본인만 접근)와 구글 로그인이 담당한다.

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBnfmTnlkF-OGSvWSMIA77E5Y6jY3c30DM",
  authDomain: "jindo-dashboard.firebaseapp.com",
  projectId: "jindo-dashboard",
  storageBucket: "jindo-dashboard.firebasestorage.app",
  messagingSenderId: "588246129058",
  appId: "1:588246129058:web:37a5e9c6ff9c4091853afb"
};

// 사진·영상을 담을 내 구글 드라이브 폴더 이름 (없으면 앱이 만든다)
export const DRIVE_FOLDER_NAME = '체육수업진도_첨부';
