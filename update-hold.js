try{const original=new URL(decodeURIComponent(location.hash.slice(1)));document.querySelector('#heldTitle').textContent=original.searchParams.get('title')||''}catch{}
