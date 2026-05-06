'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // Jika sudah login, langsung arahkan ke dashboard
  try {
    if (sessionStorage.getItem('isLoggedIn') === 'true') {
      window.location.href = 'index.html';
      return;
    }
  } catch (e) {
    console.warn('sessionStorage diblokir oleh browser');
  }


  const loginForm = document.getElementById('login-form');
  const errorMsg = document.getElementById('login-error');

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    // Kredensial default
    if (username === 'admin' && password === 'admin123') {
      // Login berhasil
      try {
        sessionStorage.setItem('isLoggedIn', 'true');
        window.location.href = 'index.html';
      } catch (e) {
        // Fallback untuk Firefox lokal
        window.location.href = 'index.html?auth=true';
      }
    } else {
      // Login gagal
      errorMsg.style.display = 'block';
      // Tambahkan animasi getar
      const container = document.querySelector('.login-container');
      container.classList.add('shake');
      setTimeout(() => {
        container.classList.remove('shake');
      }, 500);
    }
  });
});
