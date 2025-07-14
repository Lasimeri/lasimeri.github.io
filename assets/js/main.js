/*
	Sea of Glass - A place of peace and reflection
	Inspired by Revelation 4:6
*/

(function() {
	"use strict";

	// Remove preload class on page load
	window.addEventListener('load', function() {
		window.setTimeout(function() {
			document.body.classList.remove('is-preload');
		}, 100);
	});

	// Simple parallax effect for hero section
	window.addEventListener('scroll', function() {
		const scrolled = window.pageYOffset;
		const hero = document.getElementById('home');
		if (hero) {
			const rate = scrolled * -0.5;
			hero.style.transform = `translateY(${rate}px)`;
		}
	});

})();