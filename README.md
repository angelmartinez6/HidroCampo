using Microsoft.AspNetCore.Mvc;
using SistemaReservasSalas.Data;
using SistemaReservasSalas.Models;
using SistemaReservasSalas.ViewModels;
using System.Linq;

namespace SistemaReservasSalas.Controllers
{
    public class LoginController : Controller
    {
        private readonly ApplicationDbContext _context;

        public LoginController(ApplicationDbContext context)
        {
            _context = context;
        }

        public IActionResult Login()
        {
            return View();
        }

        [HttpPost]
        public IActionResult Login(LoginViewModel model)
        {
            if (!ModelState.IsValid)
            {
                return View(model);
            }

            var usuario = _context.Users.FirstOrDefault(u =>
                u.UsuarioCorreo == model.UsuarioCorreo &&
                u.Contrasena == model.Contrasena &&
                u.Estado == true);

            if (usuario == null)
            {
                ViewBag.Error = "Usuario o contraseña incorrectos";
                return View(model);
            }

            HttpContext.Session.SetString("Usuario", usuario.UsuarioCorreo);

            return RedirectToAction("Visualizacion", "Reserva");
        }

        public IActionResult Logout()
        {
            HttpContext.Session.Clear();
            return RedirectToAction("Login");
        }
    }
}
